/**
 * User Notifier — sends notifications to fleet users based on their preferences.
 *
 * Delivery channels:
 * - Telegram: via grammy bot instance (requires TELEGRAM_BOT_TOKEN env var)
 * - Callback URL: HTTP POST to operator's OpenClaw hooks endpoint (for operator-type users like Robin)
 * - Webhook: HTTP POST to configured webhook URL
 */

import type { ArmadaUser } from '@coderage-labs/armada-shared';
import { usersRepo, userProjectsRepo } from '../repositories/index.js';
import { sendGateNotification, sendPlainNotification } from './telegram-bot.js';
import { getDrizzle } from '../db/drizzle.js';
import { workflowStepRuns } from '../db/drizzle-schema.js';
import { and, eq, sql } from 'drizzle-orm';

const FLEET_UI_URL = process.env.FLEET_UI_URL || 'http://localhost:3001';

/** Tracks which Telegram messages were sent for a gate notification */
export interface TelegramNotification {
  chatId: string;
  messageId: number;
}

export interface NotifyGateOptions {
  workflowName: string;
  stepId: string;
  runId: string;
  previousOutput: string | null;
  projectId: string;
  gatePolicy?: {
    notifyOnly?: ('human' | 'operator')[];
    approveOnly?: ('human' | 'operator')[];
  };
}

export interface NotifyCompletionOptions {
  workflowName: string;
  runId: string;
  status: 'completed' | 'failed';
  projectId: string;
}

/**
 * Notify fleet users when a manual gate is reached.
 * - Filtered by project assignment (falls back to all users if no assignments)
 * - Filtered by gatePolicy.notifyOnly if set
 * - operator users: always notified (unless excluded by gatePolicy)
 * - human users: only if notifications.preferences.gates === true
 */
export async function notifyGate(opts: NotifyGateOptions): Promise<void> {
  const { workflowName, stepId, runId, previousOutput, projectId, gatePolicy } = opts;

  // Get users assigned to project (or all users if none assigned)
  let users = userProjectsRepo.getUsersForProject(projectId);
  if (users.length === 0) {
    users = usersRepo.getAll();
  }

  // Filter by gatePolicy.notifyOnly if set
  if (gatePolicy?.notifyOnly && gatePolicy.notifyOnly.length > 0) {
    users = users.filter(u => gatePolicy.notifyOnly!.includes(u.type));
  }

  const telegramNotifications: TelegramNotification[] = [];

  for (const user of users) {
    try {
      const shouldNotify =
        user.type === 'operator' ||
        (user.type === 'human' && user.notifications?.preferences?.gates === true);

      if (!shouldNotify) continue;

      const message = formatGateMessage(workflowName, stepId, runId, previousOutput);
      const telegramResult = await deliverToUser(user, message, {
        event: 'workflow.gate',
        runId,
        stepId,
        workflowName,
        previousOutput,
      });
      if (telegramResult) telegramNotifications.push(telegramResult);
    } catch (err: any) {
      console.error(`[user-notifier] Failed to notify user ${user.name}: ${err.message}`);
    }
  }

  // Persist Telegram message IDs on the step_run so we can edit them on resolution
  if (telegramNotifications.length > 0) {
    try {
      const db = getDrizzle();
      db.update(workflowStepRuns)
        .set({ telegramNotificationsJson: JSON.stringify(telegramNotifications) })
        .where(and(eq(workflowStepRuns.runId, runId), eq(workflowStepRuns.stepId, stepId)))
        .run();
    } catch (err: any) {
      console.error(`[user-notifier] Failed to persist telegram notification IDs: ${err.message}`);
    }
  }
}

/**
 * Notify fleet users when a workflow completes or fails.
 * - Filtered by project assignment (falls back to all users if no assignments)
 * - operator users: always notified
 * - human users: only if matching preference (completions/failures) is true
 */
export async function notifyCompletion(opts: NotifyCompletionOptions): Promise<void> {
  const { workflowName, runId, status, projectId } = opts;

  // Get users assigned to project (or all users if none assigned)
  let users = userProjectsRepo.getUsersForProject(projectId);
  if (users.length === 0) {
    users = usersRepo.getAll();
  }

  for (const user of users) {
    try {
      const shouldNotify =
        user.type === 'operator' ||
        (user.type === 'human' &&
          ((status === 'completed' && user.notifications?.preferences?.completions === true) ||
            (status === 'failed' && user.notifications?.preferences?.failures === true)));

      if (!shouldNotify) continue;

      const message = formatCompletionMessage(workflowName, runId, status);
      await deliverToUser(user, message, {
        event: `workflow.${status}`,
        runId,
        workflowName,
      });
    } catch (err: any) {
      console.error(`[user-notifier] Failed to notify user ${user.name}: ${err.message}`);
    }
  }
}

// ── Delivery ────────────────────────────────────────────────────────

async function deliverToUser(
  user: ArmadaUser,
  message: string,
  payload: Record<string, any>,
): Promise<TelegramNotification | null> {
  const channels = user.notifications?.channels || [];
  let telegramResult: TelegramNotification | null = null;

  const deliveries: Promise<void>[] = [];

  // Telegram delivery
  if (channels.includes('telegram') && user.notifications?.telegram?.chatId) {
    const isGate = payload.event === 'workflow.gate';
    const chatId = user.notifications.telegram.chatId;
    deliveries.push(
      sendTelegram(chatId, message, isGate, payload.runId, payload.stepId).then(msgId => {
        if (msgId !== null) telegramResult = { chatId, messageId: msgId };
      })
    );
  }

  // Callback URL delivery (operator users — always delivers if configured, independent of channels array)
  if (user.linkedAccounts?.callbackUrl && user.linkedAccounts?.hooksToken) {
    deliveries.push(sendCallback(user.linkedAccounts.callbackUrl, user.linkedAccounts.hooksToken, payload));
  }

  // Webhook delivery
  if (channels.includes('webhook') && user.notifications?.webhook?.url) {
    deliveries.push(sendWebhook(user.notifications.webhook.url, undefined, payload));
  }

  await Promise.allSettled(deliveries);
  return telegramResult;
}

// ── Message formatting ──────────────────────────────────────────────

/** Escape HTML special chars for Telegram parse_mode: 'HTML' */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatGateMessage(
  workflowName: string,
  stepId: string,
  runId: string,
  previousOutput: string | null,
): string {
  let msg = `⏸️ Workflow <b>${escapeHtml(workflowName)}</b> paused at gate <b>${escapeHtml(stepId)}</b>\n\n<code>${runId}</code>`;
  if (previousOutput) {
    // Telegram message limit is 4096 chars; reserve ~200 for the surrounding message chrome
    const maxPreview = 3800;
    const preview = previousOutput.length > maxPreview ? previousOutput.slice(0, maxPreview) + '...' : previousOutput;
    msg += `\n\n<b>Previous step output:</b>\n<pre>${escapeHtml(preview)}</pre>`;
  }
  return msg;
}

function formatCompletionMessage(
  workflowName: string,
  runId: string,
  status: 'completed' | 'failed',
): string {
  const emoji = status === 'completed' ? '✅' : '❌';
  return `${emoji} Workflow <b>${escapeHtml(workflowName)}</b> ${status}\n\n<code>${runId}</code>`;
}

// ── Channel implementations ─────────────────────────────────────────

async function sendTelegram(
  chatId: string,
  message: string,
  isGate: boolean,
  runId?: string,
  stepId?: string,
): Promise<number | null> {
  try {
    if (isGate && runId && stepId) {
      // Send gate notification with approve/reject buttons — returns message ID
      return await sendGateNotification(chatId, message, runId, stepId);
    } else {
      // Send plain notification (completion/failure)
      await sendPlainNotification(chatId, message);
      return null;
    }
  } catch (err: any) {
    console.error(`[user-notifier] Telegram delivery failed: ${err.message}`);
    return null;
  }
}

async function sendCallback(url: string, token: string, payload: Record<string, any>): Promise<void> {
  try {
    const resp = await fetch(`${url}/fleet/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });

    if (!resp.ok) {
      console.error(`[user-notifier] Callback error for ${url}: ${await resp.text()}`);
    }
  } catch (err: any) {
    console.error(`[user-notifier] Callback delivery failed: ${err.message}`);
  }
}

async function sendWebhook(url: string, secret: string | undefined, payload: Record<string, any>): Promise<void> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) headers['X-Webhook-Secret'] = secret;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });

    if (!resp.ok) {
      console.error(`[user-notifier] Webhook error for ${url}: ${await resp.text()}`);
    }
  } catch (err: any) {
    console.error(`[user-notifier] Webhook delivery failed: ${err.message}`);
  }
}
