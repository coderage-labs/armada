/**
 * Telegram Bot Service — handles interactive bot for workflow gates.
 *
 * Uses grammy (TypeScript-first library) with long-polling.
 * Handles:
 * - /start command
 * - Callback queries for gate approve/reject/retry
 * - Multi-level retry: step selection → feedback prompt → retry execution
 * - Interactive buttons on gate notifications
 */

import { Bot, InlineKeyboard } from 'grammy';
import { usersRepo } from '../repositories/index.js';
import { notificationChannelRepo } from '../repositories/notification-channel-repo.js';
import {
  approveGate,
  rejectGate,
  retryStep,
  getGateUpstreamSteps,
} from './workflow-engine.js';
import { createLinkingCode, getPendingCode } from './linking-service.js';

/** Escape HTML special chars for Telegram parse_mode: 'HTML' */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let bot: Bot | null = null;
let isPolling = false;

/** Pending retry state — keyed by chatId (one pending retry per user) */
const pendingRetries = new Map<
  string,
  {
    runId: string;
    stepId: string;
    targetStepId: string;
    targetStepName: string;
    messageId: number;
    chatId: string;
  }
>();

/** Build the standard 3-button gate keyboard */
function gateKeyboard(runId: string, stepId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Approve', `gate:approve:${runId}:${stepId}`)
    .text('🔄 Retry', `gate:retry:${runId}:${stepId}`)
    .text('❌ Reject', `gate:reject:${runId}:${stepId}`);
}

/**
 * Resolve the Telegram bot token.
 * Prefers the first enabled Telegram notification channel's config.token,
 * falls back to TELEGRAM_BOT_TOKEN env var for backwards compatibility.
 */
function resolveBotToken(): string | undefined {
  try {
    const channels = notificationChannelRepo.findAll();
    const telegramChannel = channels.find(c => c.type === 'telegram' && c.enabled && c.config?.token);
    if (telegramChannel) {
      return telegramChannel.config.token as string;
    }
  } catch {
    // DB may not be ready yet — fall through to env var
  }
  return process.env.TELEGRAM_BOT_TOKEN;
}

/**
 * Initialize the Telegram bot.
 * Only starts if a bot token is available (from notification channel config or env var).
 */
export async function initTelegramBot(): Promise<void> {
  const TELEGRAM_BOT_TOKEN = resolveBotToken();
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('⏭️  Skipping Telegram bot (no bot token configured)');
    return;
  }

  try {
    bot = new Bot(TELEGRAM_BOT_TOKEN);

    // Handle /start command — linking flow
    bot.command('start', async (ctx) => {
      const telegramUserId = ctx.from?.id.toString();
      if (!telegramUserId) return;

      const users = usersRepo.getAll();
      const linked = users.find(u =>
        u.channels?.telegram?.platformId === telegramUserId,
      );

      if (linked) {
        await ctx.reply(`✅ You're linked as <b>${escapeHtml(linked.displayName)}</b>. You'll receive notifications here.`, {
          parse_mode: 'HTML',
        });
        return;
      }

      // Check for an existing pending code first (avoid generating a new one on every /start)
      const existingCode = getPendingCode('telegram', telegramUserId);
      const code = existingCode ?? createLinkingCode('telegram', telegramUserId);

      await ctx.reply(
        '👋 Welcome! To link your Telegram to Armada, enter this code on your Account page:\n\n' +
        `<code>${code}</code>\n\n` +
        'This code expires in 10 minutes.',
        { parse_mode: 'HTML' },
      );
    });

    // /link is an alias for /start (in case the user sends /link instead)
    bot.command('link', async (ctx) => {
      const telegramUserId = ctx.from?.id.toString();
      if (!telegramUserId) return;

      const users = usersRepo.getAll();
      const linked = users.find(u =>
        u.channels?.telegram?.platformId === telegramUserId,
      );

      if (linked) {
        await ctx.reply(`✅ You're linked as <b>${escapeHtml(linked.displayName)}</b>. You'll receive notifications here.`, {
          parse_mode: 'HTML',
        });
        return;
      }

      const existingCode = getPendingCode('telegram', telegramUserId);
      const code = existingCode ?? createLinkingCode('telegram', telegramUserId);

      await ctx.reply(
        '👋 Welcome! To link your Telegram to Armada, enter this code on your Account page:\n\n' +
        `<code>${code}</code>\n\n` +
        'This code expires in 10 minutes.',
        { parse_mode: 'HTML' },
      );
    });

    // Handle /status command
    bot.command('status', async (ctx) => {
      const telegramUserId = ctx.from?.id.toString();
      if (!telegramUserId) return;

      const users = usersRepo.getAll();
      const user = users.find(u =>
        u.channels?.telegram?.platformId === telegramUserId,
      );

      if (user) {
        await ctx.reply(
          `✅ Linked as <b>${escapeHtml(user.displayName)}</b> (${escapeHtml(user.name)})`,
          { parse_mode: 'HTML' },
        );
      } else {
        await ctx.reply('❌ Not linked. Send /start to link your account.');
      }
    });

    // Handle /help command
    bot.command('help', async (ctx) => {
      await ctx.reply(
        '🤖 <b>Armada Bot</b>\n\n' +
        '/start — Link your Telegram account\n' +
        '/status — Check your linked account\n' +
        '/help — Show this message',
        { parse_mode: 'HTML' },
      );
    });

    // Handle callback queries (approve/reject/retry buttons, triage actions)
    bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const telegramUserId = ctx.from?.id.toString();

      if (!telegramUserId) {
        await ctx.answerCallbackQuery({ text: 'Error: No user ID' });
        return;
      }

      // Parse callback data
      const parts = data.split(':');
      const namespace: string = parts[0];

      if (parts.length < 3 || (namespace !== 'gate' && namespace !== 'triage')) {
        await ctx.answerCallbackQuery({ text: 'Invalid callback data' });
        return;
      }

      // Auth: verify the Telegram user ID matches a linked Armada user
      const users = usersRepo.getAll();
      const user = users.find(u =>
        u.channels?.telegram?.platformId === telegramUserId,
      );

      if (!user) {
        await ctx.answerCallbackQuery({ text: 'Unauthorized' });
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        return;
      }

      const action = parts[1];

      try {
        // ── Triage actions (short format: t:d:pid8:num:wfid8 or legacy triage:dispatch:...) ──
        if (namespace === 'triage' || namespace === 't') {
          const isShort = namespace === 't';
          if ((isShort ? action === 'd' : action === 'dispatch') && parts.length >= 4) {
            // Short: t:d:<pid8>:<issueNumber>:<wfid8>
            // Legacy: triage:dispatch:<projectId>:<issueNumber>[:<workflowId>]
            const pidFragment = parts[2];
            const issueNumber = parseInt(parts[3], 10);
            const wfFragment = parts[4]; // may be undefined for legacy without workflow

            await ctx.answerCallbackQuery({ text: '🔄 Dispatching workflow...' });

            // Resolve short IDs to full UUIDs
            const { projectsRepo } = await import('../repositories/index.js');
            const allProjects = projectsRepo.getAll();
            const project = allProjects.find(p => p.id.startsWith(pidFragment)) ?? allProjects.find(p => p.id === pidFragment);
            const projectId = project?.id ?? pidFragment;

            const { triageDispatch } = await import('./triage.js');
            const { getWorkflowsForProject } = await import('./workflow-engine.js');
            const workflows = getWorkflowsForProject(projectId).filter((w: any) => w.enabled);

            let resolvedWorkflowId: string | undefined;
            if (wfFragment) {
              // Match workflow by ID prefix (short format) or full ID (legacy)
              const match = workflows.find(w => w.id.startsWith(wfFragment) || w.id === wfFragment);
              resolvedWorkflowId = match?.id;
            }
            if (!resolvedWorkflowId) {
              if (workflows.length === 0) {
                await ctx.reply('❌ No enabled workflows are configured for this project.');
                return;
              }
              resolvedWorkflowId = workflows[0].id;
            }

            const result = await triageDispatch({
              projectId,
              issueNumber,
              workflowId: resolvedWorkflowId,
            });

            if (result.error) {
              await ctx.reply(`❌ Dispatch failed: ${escapeHtml(result.error)}`, { parse_mode: 'HTML' });
            } else {
              const originalText = ctx.callbackQuery.message?.text ?? '';
              await ctx.editMessageText(
                `${originalText}\n\n🔄 Workflow <b>${escapeHtml(result.workflowName ?? 'unknown')}</b> dispatched by ${escapeHtml(user.displayName)}`,
                { parse_mode: 'HTML', reply_markup: undefined },
              );
            }

          } else if ((isShort ? action === 'm' : action === 'mark') && parts.length >= 4) {
            // Short: t:m:<pid8>:<issueNumber>  Legacy: triage:mark:<projectId>:<issueNumber>
            const pidFragment = parts[2];
            const issueNumber = parseInt(parts[3], 10);

            // Resolve short ID
            const { projectsRepo: pr } = await import('../repositories/index.js');
            const proj = pr.getAll().find(p => p.id.startsWith(pidFragment)) ?? pr.getAll().find(p => p.id === pidFragment);
            const projectId = proj?.id ?? pidFragment;

            const { markIssueTriaged } = await import('./triage.js');
            markIssueTriaged(projectId, issueNumber);

            const originalText = ctx.callbackQuery.message?.text ?? '';
            await ctx.editMessageText(
              `${originalText}\n\n✅ Triaged by ${escapeHtml(user.displayName)}`,
              { parse_mode: 'HTML', reply_markup: undefined },
            );
            await ctx.answerCallbackQuery({ text: '✅ Marked as triaged' });

          } else {
            await ctx.answerCallbackQuery({ text: 'Unknown triage action' });
          }
          return;
        }

        // ── Gate actions ────────────────────────────────────────────────────
        if (action === 'approve' && parts.length === 4) {
          const [, , runId, stepId] = parts;
          await approveGate(runId, stepId, user.displayName);
          await ctx.editMessageText(
            `${ctx.callbackQuery.message?.text}\n\n✅ Approved by ${user.displayName}`,
            { reply_markup: undefined },
          );
          await ctx.answerCallbackQuery({ text: 'Gate approved' });

        } else if (action === 'reject' && parts.length === 4) {
          const [, , runId, stepId] = parts;
          await rejectGate(runId, stepId, `Rejected via Telegram by ${user.displayName}`);
          await ctx.editMessageText(
            `${ctx.callbackQuery.message?.text}\n\n❌ Rejected by ${user.displayName}`,
            { reply_markup: undefined },
          );
          await ctx.answerCallbackQuery({ text: 'Gate rejected' });

        } else if (action === 'retry' && parts.length === 4) {
          const [, , runId, stepId] = parts;
          await handleRetry(ctx, runId, stepId);

        } else if (action === 'retrystep' && parts.length === 4) {
          // Step selected from multi-step menu: gate:retrystep:<runId>:<targetStepId>
          const [, , runId, targetStepId] = parts;
          const chatId = ctx.chat?.id.toString();
          if (!chatId) return;
          await promptForFeedback(ctx, chatId, runId, '', targetStepId, targetStepId);

        } else if (action === 'back' && parts.length === 4) {
          // Back to main gate keyboard: gate:back:<runId>:<stepId>
          const [, , runId, stepId] = parts;
          // Clear any pending retry for this user
          const chatId = ctx.chat?.id.toString();
          if (chatId) pendingRetries.delete(chatId);
          await ctx.editMessageReplyMarkup({
            reply_markup: gateKeyboard(runId, stepId),
          });
          await ctx.answerCallbackQuery({ text: 'Back to gate controls' });

        } else {
          await ctx.answerCallbackQuery({ text: 'Unknown action' });
        }
      } catch (err: any) {
        console.error('[telegram-bot] Error handling callback query:', err);
        await ctx.answerCallbackQuery({ text: `Error: ${err.message}` });
      }
    });

    // Handle text messages — check for pending retry feedback
    bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const pending = pendingRetries.get(chatId);
      if (!pending) return; // Not waiting for feedback — ignore

      const text = ctx.message.text.trim();
      const feedback = text === '/skip' ? undefined : text;

      try {
        await retryStep(pending.runId, pending.targetStepId, feedback);

        // Edit the original gate message to show retry status
        await bot!.api.editMessageText(
          Number(pending.chatId),
          pending.messageId,
          `🔄 Retrying <b>${escapeHtml(pending.targetStepName)}</b>...${feedback ? `\n\n💬 Feedback: ${escapeHtml(feedback)}` : ''}`,
          { parse_mode: 'HTML', reply_markup: undefined },
        );

        await ctx.reply(`✅ Retry dispatched for <b>${escapeHtml(pending.targetStepName)}</b>${feedback ? ' with feedback' : ''}.`, {
          parse_mode: 'HTML',
        });
      } catch (err: any) {
        console.error('[telegram-bot] Error retrying step:', err);
        await ctx.reply(`❌ Retry failed: ${err.message}`);
      } finally {
        pendingRetries.delete(chatId);
      }
    });

    // Start polling
    bot.start();
    isPolling = true;
    console.log('🤖 Telegram bot started (long-polling)');
  } catch (err: any) {
    console.error('[telegram-bot] Failed to start bot:', err.message);
  }
}

/**
 * Handle the retry button click.
 * If one upstream step → go straight to feedback prompt.
 * If multiple → show step selection menu.
 */
async function handleRetry(ctx: any, runId: string, gateStepId: string): Promise<void> {
  const upstreamSteps = getGateUpstreamSteps(runId, gateStepId);

  if (upstreamSteps.length === 0) {
    await ctx.answerCallbackQuery({ text: 'No retryable upstream steps found' });
    return;
  }

  const chatId = ctx.chat?.id.toString();
  if (!chatId) return;

  if (upstreamSteps.length === 1) {
    // Single upstream step — go straight to feedback prompt
    const target = upstreamSteps[0];
    await promptForFeedback(ctx, chatId, runId, gateStepId, target.id, target.name);
  } else {
    // Multiple upstream steps — show selection keyboard
    const keyboard = new InlineKeyboard();
    for (const step of upstreamSteps) {
      keyboard.text(`🔄 ${step.name}`, `gate:retrystep:${runId}:${step.id}`).row();
    }
    keyboard.text('⬅️ Back', `gate:back:${runId}:${gateStepId}`);

    await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
    await ctx.answerCallbackQuery({ text: 'Select step to retry' });
  }
}

/**
 * Prompt the user to reply with feedback for the retry.
 */
async function promptForFeedback(
  ctx: any,
  chatId: string,
  runId: string,
  gateStepId: string,
  targetStepId: string,
  targetStepName: string,
): Promise<void> {
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (!messageId) return;

  await ctx.editMessageText(
    `💬 Reply to this message with feedback for the <b>${escapeHtml(targetStepName)}</b> step, or send /skip`,
    { parse_mode: 'HTML', reply_markup: undefined },
  );

  pendingRetries.set(chatId, {
    runId,
    stepId: gateStepId,
    targetStepId,
    targetStepName,
    messageId,
    chatId,
  });

  await ctx.answerCallbackQuery({ text: 'Send feedback or /skip' });
}

/**
 * Stop the Telegram bot polling.
 */
export async function stopTelegramBot(): Promise<void> {
  if (bot && isPolling) {
    await bot.stop();
    isPolling = false;
    console.log('🛑 Telegram bot stopped');
  }
}

/**
 * Send a message with inline keyboard for gate notifications.
 * Returns the message ID so it can be stored and later edited on resolution.
 */
export async function sendGateNotification(
  chatId: string,
  message: string,
  runId: string,
  stepId: string,
): Promise<number | null> {
  if (!bot) {
    console.warn('[telegram-bot] Bot not initialized, cannot send gate notification');
    return null;
  }

  const sent = await bot.api.sendMessage(chatId, message, {
    parse_mode: 'HTML',
    reply_markup: gateKeyboard(runId, stepId),
  });
  return sent.message_id;
}

/**
 * Edit a previously-sent gate notification to show the resolution.
 * Called when a gate is approved or rejected (e.g. from the web UI).
 */
export async function editGateResolution(
  chatId: string,
  messageId: number,
  resolvedText: string,
): Promise<void> {
  if (!bot) {
    console.warn('[telegram-bot] Bot not initialized, cannot edit gate notification');
    return;
  }

  try {
    await bot.api.editMessageText(
      Number(chatId),
      messageId,
      resolvedText,
      { parse_mode: 'HTML', reply_markup: undefined },
    );
  } catch (err: any) {
    // Ignore "message is not modified" errors — can happen if Telegram bot already edited it
    if (!err.message?.includes('not modified')) {
      console.error('[telegram-bot] Failed to edit gate resolution message:', err.message);
    }
  }
}

/**
 * Send a plain message (for completions/failures).
 */
export async function sendPlainNotification(chatId: string, message: string): Promise<void> {
  if (!bot) {
    console.warn('[telegram-bot] Bot not initialized, cannot send plain notification');
    return;
  }

  await bot.api.sendMessage(chatId, message, { parse_mode: 'HTML' });
}

/**
 * Send a triage fallback notification with inline action buttons.
 * Buttons allow the operator to dispatch a workflow or mark the issue triaged directly from Telegram.
 */
export async function sendTriageNotification(
  chatId: string,
  message: string,
  projectId: string,
  issueNumber: number,
  issueUrl: string,
): Promise<void> {
  if (!bot) {
    console.warn('[telegram-bot] Bot not initialized, cannot send triage notification');
    return;
  }

  // List available workflows as individual buttons
  const { getWorkflowsForProject } = await import('./workflow-engine.js');
  const workflows = getWorkflowsForProject(projectId).filter(w => w.enabled);
  
  // Telegram callback data limit is 64 bytes — use short IDs (first 8 chars of UUID)
  const pid = projectId.slice(0, 8);
  const keyboard = new InlineKeyboard();
  for (const wf of workflows) {
    keyboard.text(`🔄 ${wf.name}`, `t:d:${pid}:${issueNumber}:${wf.id.slice(0, 8)}`).row();
  }
  keyboard.text('✅ Mark Triaged', `t:m:${pid}:${issueNumber}`);

  if (issueUrl) {
    keyboard.row().url('🔗 View Issue', issueUrl);
  }

  await bot.api.sendMessage(chatId, message, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}
