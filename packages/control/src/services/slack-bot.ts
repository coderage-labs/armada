/**
 * Slack Bot — Bolt for JavaScript integration for Armada notifications.
 *
 * Supports:
 * - DM linking flow: user sends "link" → gets code → enters on Account page
 * - Gate notifications with Block Kit approve/reject buttons
 * - Completion/failure plain notifications
 * - Socket Mode (no public URL needed) or HTTP events mode
 */

import { App } from '@slack/bolt';
import { createLinkingCode, getPendingCode } from './linking-service.js';
import { usersRepo } from '../repositories/index.js';
import { notificationChannelRepo } from '../repositories/notification-channel-repo.js';

let slackApp: App | null = null;

export function initSlackBot(): void {
  // Get Slack channel config from DB
  const channels = notificationChannelRepo.getByType('slack');
  const channel = channels.find(c => c.enabled);
  if (!channel) {
    console.log('[slack-bot] No enabled Slack channel configured, skipping init');
    return;
  }

  const { token, signingSecret, appToken } = channel.config as {
    token?: string;         // Bot User OAuth Token (xoxb-...)
    signingSecret?: string; // App signing secret
    appToken?: string;      // App-level token for socket mode (xapp-...)
  };

  if (!token || !signingSecret) {
    console.error('[slack-bot] Slack channel config missing token or signingSecret');
    return;
  }

  // Use Socket Mode if appToken is provided, otherwise HTTP events
  slackApp = new App({
    token,
    signingSecret,
    ...(appToken ? { socketMode: true, appToken } : {}),
  });

  // "link" or "start" command — DM "link" to begin account linking
  slackApp.message(/^(link|start)$/i, async ({ message, say }) => {
    if (message.subtype) return; // Skip bot messages, etc.
    const slackUserId = (message as any).user;
    if (!slackUserId) return;

    // Check if already linked
    const users = usersRepo.getAll();
    const existingUser = users.find(u =>
      u.channels?.slack?.platformId === slackUserId
    );

    if (existingUser) {
      await say(`✅ You're already linked as *${existingUser.displayName}* (${existingUser.name}). You'll receive notifications here.`);
      return;
    }

    // Check for existing pending code
    const existing = getPendingCode('slack', slackUserId);
    if (existing) {
      await say(`Your linking code is still active: \`${existing}\`\n\nEnter this on your Armada Account page to complete linking. Expires in 10 minutes.`);
      return;
    }

    const code = createLinkingCode('slack', slackUserId);
    await say(`👋 Welcome! To link your Slack account to Armada, enter this code on your Account page:\n\n\`${code}\`\n\nThis code expires in 10 minutes.`);
  });

  // "status" command — check linking status
  slackApp.message(/^status$/i, async ({ message, say }) => {
    if (message.subtype) return;
    const slackUserId = (message as any).user;
    const users = usersRepo.getAll();
    const user = users.find(u => u.channels?.slack?.platformId === slackUserId);
    if (user) {
      await say(`✅ Linked as *${user.displayName}* (${user.name})`);
    } else {
      await say(`❌ Not linked. Send \`link\` to link your Slack account.`);
    }
  });

  // "help" command
  slackApp.message(/^help$/i, async ({ message, say }) => {
    if (message.subtype) return;
    await say(
      '🤖 *Armada Bot*\n\n' +
      '• `link` — Link your Slack account\n' +
      '• `status` — Check your linked account\n' +
      '• `help` — Show this message'
    );
  });

  // Handle interactive button action: gate approve
  slackApp.action('gate_approve', async ({ body, ack, respond }) => {
    await ack();
    const slackUserId = body.user.id;

    // Find Armada user by Slack identity
    const users = usersRepo.getAll();
    const user = users.find(u =>
      u.channels?.slack?.platformId === slackUserId
    );

    if (!user) {
      await respond({ text: '❌ Your Slack account is not linked to Armada. Send `link` to set up.' });
      return;
    }

    // Extract runId and stepId from action value
    const value = (body as any).actions?.[0]?.value || '';
    const [runId, stepId] = value.split(':');

    if (!runId || !stepId) {
      await respond({ text: '❌ Invalid action data.' });
      return;
    }

    try {
      // Import workflow engine dynamically to avoid circular deps
      const { approveGate } = await import('./workflow-engine.js');
      await approveGate(runId, stepId, user.id);
      await respond({ text: `✅ Gate *${stepId}* approved by ${user.displayName}`, replace_original: true });
    } catch (err: any) {
      await respond({ text: `❌ Failed to approve: ${err.message}` });
    }
  });

  // Handle interactive button action: gate reject
  slackApp.action('gate_reject', async ({ body, ack, respond }) => {
    await ack();
    const slackUserId = body.user.id;

    const users = usersRepo.getAll();
    const user = users.find(u => u.channels?.slack?.platformId === slackUserId);

    if (!user) {
      await respond({ text: '❌ Your Slack account is not linked to Armada.' });
      return;
    }

    const value = (body as any).actions?.[0]?.value || '';
    const [runId, stepId] = value.split(':');

    if (!runId || !stepId) {
      await respond({ text: '❌ Invalid action data.' });
      return;
    }

    try {
      const { rejectGate } = await import('./workflow-engine.js');
      await rejectGate(runId, stepId, `Rejected via Slack by ${user.displayName}`);
      await respond({ text: `❌ Gate *${stepId}* rejected by ${user.displayName}`, replace_original: true });
    } catch (err: any) {
      await respond({ text: `❌ Failed to reject: ${err.message}` });
    }
  });

  // Start the app
  (async () => {
    try {
      if (appToken) {
        await slackApp!.start();
        console.log('[slack-bot] Slack bot started in Socket Mode');
      } else {
        // HTTP mode — app will listen on its own port or be mounted on express
        console.log('[slack-bot] Slack bot initialized in HTTP mode (events endpoint needed)');
      }
    } catch (err: any) {
      console.error(`[slack-bot] Failed to start: ${err.message}`);
    }
  })();
}

/** Send a gate notification with Block Kit approve/reject buttons */
export async function sendSlackGateNotification(
  userId: string,
  message: string,
  runId: string,
  stepId: string,
): Promise<void> {
  if (!slackApp) return;

  try {
    await slackApp.client.chat.postMessage({
      channel: userId, // DM the user
      text: message,   // Fallback text
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: message },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Approve' },
              style: 'primary',
              action_id: 'gate_approve',
              value: `${runId}:${stepId}`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '❌ Reject' },
              style: 'danger',
              action_id: 'gate_reject',
              value: `${runId}:${stepId}`,
            },
          ],
        },
      ],
    });
  } catch (err: any) {
    console.error(`[slack-bot] Failed to send gate notification: ${err.message}`);
  }
}

/** Send a plain notification (completion/failure) */
export async function sendSlackNotification(
  userId: string,
  message: string,
): Promise<void> {
  if (!slackApp) return;

  try {
    await slackApp.client.chat.postMessage({
      channel: userId,
      text: message,
    });
  } catch (err: any) {
    console.error(`[slack-bot] Failed to send notification: ${err.message}`);
  }
}

export function getSlackApp(): App | null {
  return slackApp;
}
