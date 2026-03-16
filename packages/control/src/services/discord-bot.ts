/**
 * discord-bot.ts
 *
 * Discord bot integration for Armada notifications.
 * Handles DM linking flow and gate notifications with interactive buttons.
 *
 * Bot commands (DM only):
 *   !link / !start — generate a linking code
 *   !status        — check linked account
 *   !help          — show help message
 */

import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } from 'discord.js';
import { createLinkingCode, getPendingCode } from './linking-service.js';
import { usersRepo } from '../repositories/index.js';
import { notificationChannelRepo } from '../repositories/index.js';

let client: Client | null = null;

export function initDiscordBot(): void {
  const channels = notificationChannelRepo.getByType('discord');
  const channel = channels.find(c => c.enabled);
  if (!channel) {
    console.log('[discord-bot] No enabled Discord channel configured, skipping init');
    return;
  }

  const { token } = channel.config as { token?: string };
  if (!token) {
    console.error('[discord-bot] Discord channel config missing bot token');
    return;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on(Events.MessageCreate, async (message) => {
    // Only handle DMs, ignore bot messages
    if (!message.guild && !message.author.bot) {
      const content = message.content.trim().toLowerCase();
      const discordUserId = message.author.id;

      if (content === '!link' || content === '!start') {
        // Check if already linked
        const users = usersRepo.getAll();
        const existingUser = users.find(u =>
          u.channels?.discord?.platformId === discordUserId
        );

        if (existingUser) {
          await message.reply(`✅ You're already linked as **${existingUser.displayName}** (${existingUser.name}). You'll receive notifications here.`);
          return;
        }

        const existing = getPendingCode('discord', discordUserId);
        if (existing) {
          await message.reply(`Your linking code is still active: \`${existing}\`\n\nEnter this on your Armada Account page. Expires in 10 minutes.`);
          return;
        }

        const code = createLinkingCode('discord', discordUserId);
        await message.reply(`👋 Welcome! To link your Discord to Armada, enter this code on your Account page:\n\n\`${code}\`\n\nThis code expires in 10 minutes.`);
      } else if (content === '!status') {
        const users = usersRepo.getAll();
        const user = users.find(u => u.channels?.discord?.platformId === discordUserId);
        if (user) {
          await message.reply(`✅ Linked as **${user.displayName}** (${user.name})`);
        } else {
          await message.reply('❌ Not linked. Send `!link` to link your Discord account.');
        }
      } else if (content === '!help') {
        await message.reply(
          '🤖 **Armada Bot**\n\n' +
          '`!link` — Link your Discord account\n' +
          '`!status` — Check your linked account\n' +
          '`!help` — Show this message'
        );
      }
    }
  });

  // Handle button interactions (gate approve/reject)
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    const discordUserId = interaction.user.id;
    const users = usersRepo.getAll();
    const user = users.find(u => u.channels?.discord?.platformId === discordUserId);

    if (!user) {
      await interaction.reply({ content: '❌ Your Discord account is not linked to Armada. DM me `!link` to set up.', ephemeral: true });
      return;
    }

    const [action, runId, stepId] = interaction.customId.split(':');

    if (!runId || !stepId) {
      await interaction.reply({ content: '❌ Invalid action data.', ephemeral: true });
      return;
    }

    try {
      if (action === 'gate_approve') {
        const { approveGate } = await import('./workflow-engine.js');
        approveGate(runId, stepId, user.id);
        await interaction.update({ content: `✅ Gate **${stepId}** approved by ${user.displayName}`, components: [] });
      } else if (action === 'gate_reject') {
        const { rejectGate } = await import('./workflow-engine.js');
        rejectGate(runId, stepId, 'Rejected via Discord', user.id);
        await interaction.update({ content: `❌ Gate **${stepId}** rejected by ${user.displayName}`, components: [] });
      }
    } catch (err: any) {
      await interaction.reply({ content: `❌ Failed: ${err.message}`, ephemeral: true });
    }
  });

  client.on(Events.ClientReady, () => {
    console.log(`[discord-bot] Logged in as ${client!.user?.tag}`);
  });

  client.login(token).catch(err => {
    console.error(`[discord-bot] Failed to login: ${err.message}`);
  });
}

/**
 * Convert HTML-formatted message (used by Telegram) to Discord markdown.
 * Discord uses markdown; Telegram uses HTML.
 */
export function htmlToDiscordMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gs, '**$1**')
    .replace(/<i>(.*?)<\/i>/gs, '*$1*')
    .replace(/<code>(.*?)<\/code>/gs, '`$1`')
    .replace(/<pre>(.*?)<\/pre>/gs, '```\n$1\n```')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Send a gate notification with approve/reject buttons via DM */
export async function sendDiscordGateNotification(
  userId: string,
  message: string,
  runId: string,
  stepId: string,
): Promise<void> {
  if (!client) return;

  try {
    const user = await client.users.fetch(userId);
    const dm = await user.createDM();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`gate_approve:${runId}:${stepId}`)
        .setLabel('✅ Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`gate_reject:${runId}:${stepId}`)
        .setLabel('❌ Reject')
        .setStyle(ButtonStyle.Danger),
    );

    await dm.send({ content: htmlToDiscordMarkdown(message), components: [row] });
  } catch (err: any) {
    console.error(`[discord-bot] Failed to send gate notification: ${err.message}`);
  }
}

/** Send a plain notification via DM */
export async function sendDiscordNotification(
  userId: string,
  message: string,
): Promise<void> {
  if (!client) return;

  try {
    const user = await client.users.fetch(userId);
    const dm = await user.createDM();
    await dm.send(htmlToDiscordMarkdown(message));
  } catch (err: any) {
    console.error(`[discord-bot] Failed to send notification: ${err.message}`);
  }
}

export function getDiscordClient(): Client | null {
  return client;
}
