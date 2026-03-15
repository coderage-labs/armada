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
import {
  approveGate,
  rejectGate,
  retryStep,
  getGateUpstreamSteps,
} from './workflow-engine.js';

/** Escape HTML special chars for Telegram parse_mode: 'HTML' */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

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
 * Initialize the Telegram bot.
 * Only starts if TELEGRAM_BOT_TOKEN is set.
 */
export async function initTelegramBot(): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('⏭️  Skipping Telegram bot (TELEGRAM_BOT_TOKEN not set)');
    return;
  }

  try {
    bot = new Bot(TELEGRAM_BOT_TOKEN);

    // Handle /start command
    bot.command('start', async (ctx) => {
      await ctx.reply('Armada bot ready 🤖');
    });

    // Handle callback queries (approve/reject/retry buttons)
    bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const telegramUserId = ctx.from?.id.toString();

      if (!telegramUserId) {
        await ctx.answerCallbackQuery({ text: 'Error: No user ID' });
        return;
      }

      // Parse callback data
      const parts = data.split(':');
      if (parts.length < 3 || parts[0] !== 'gate') {
        await ctx.answerCallbackQuery({ text: 'Invalid callback data' });
        return;
      }

      const action = parts[1];

      // Auth: verify the Telegram user ID matches a user's linkedAccounts.telegram
      const users = usersRepo.getAll();
      const user = users.find(u => u.linkedAccounts?.telegram === telegramUserId);

      if (!user) {
        await ctx.answerCallbackQuery({ text: 'Unauthorized' });
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        return;
      }

      try {
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
