/**
 * User Notifier — sends notifications to users based on their preferences.
 *
 * Delivery channels:
 * - Telegram: via grammy bot instance (requires system channel to be configured + enabled)
 * - Callback URL: HTTP POST to operator's OpenClaw hooks endpoint (for operator-type users like Robin)
 * - Webhook: HTTP POST to configured webhook URL
 *
 * Delivery rules:
 * 1. System channel must be configured and enabled (notificationChannelRepo.getEnabled())
 * 2. User must have a linked identity for that channel (user.channels)
 * 3. User preferences must allow it
 * 4. Not in quiet hours (for non-critical notifications like completions)
 */

import type { ArmadaUser } from '@coderage-labs/armada-shared';
import { usersRepo, userProjectsRepo, notificationChannelRepo } from '../repositories/index.js';
import { sendGateNotification, sendPlainNotification } from './telegram-bot.js';
import { sendSlackGateNotification, sendSlackNotification } from './slack-bot.js';
import { sendDiscordGateNotification, sendDiscordNotification } from './discord-bot.js';
import { getDrizzle } from '../db/drizzle.js';
import { workflowStepRuns } from '../db/drizzle-schema.js';
import { and, eq, sql } from 'drizzle-orm';

const ARMADA_UI_URL = process.env.ARMADA_UI_URL || 'http://localhost:3001';

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

export interface NotifyTriageOperatorFallbackOptions {
  issueNumber: number;
  issueTitle: string;
  projectId: string;
  projectName: string;
  reason: string;
}

// ── Quiet hours ─────────────────────────────────────────────────────

/**
 * Returns true if the current time falls within the user's configured quiet hours.
 * Handles overnight ranges (e.g. 23:00 → 08:00).
 */
export function isInQuietHours(user: ArmadaUser): boolean {
  const quiet = user.notifications?.preferences?.quietHours;
  if (!quiet?.start || !quiet?.end) return false;

  const tz = (quiet as any).tz || 'UTC';
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz,
  });
  const currentTime = formatter.format(new Date());

  const start = quiet.start; // e.g. "23:00"
  const end = quiet.end;     // e.g. "08:00"

  // Handle overnight range (23:00 → 08:00)
  if (start > end) {
    return currentTime >= start || currentTime < end;
  }
  return currentTime >= start && currentTime < end;
}

// ── Public notification functions ───────────────────────────────────

/**
 * Notify users when a manual gate is reached.
 * - Filtered by project assignment (falls back to all users if no assignments)
 * - Filtered by gatePolicy.notifyOnly if set
 * - operator users: always notified (unless excluded by gatePolicy)
 * - human users: only if notifications.preferences.gates === true
 * - Gates are always delivered regardless of quiet hours (they require action)
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

      // Gates always deliver — they require human action, quiet hours do not apply

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
 * Notify users when a workflow completes or fails.
 * - Filtered by project assignment (falls back to all users if no assignments)
 * - operator users: always notified
 * - human users: only if matching preference (completions/failures) is true
 * - Completions/failures are skipped during quiet hours
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

      // Skip completions/failures during quiet hours — they are non-critical
      if (isInQuietHours(user)) {
        console.log(`[user-notifier] Skipping ${status} notification for ${user.name} — quiet hours`);
        continue;
      }

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

/**
 * Notify operator-type users when a triage falls back to manual handling.
 * - Targets operator users assigned to the project (falls back to all operators)
 * - Skips non-operator users (humans don't handle triage)
 * - Skips quiet hours (triage fallback needs attention but isn't blocking like a gate)
 * - Rate-limited: at most one notification per issue (caller responsibility via cooldown map)
 */
export async function notifyTriageOperatorFallback(opts: NotifyTriageOperatorFallbackOptions): Promise<void> {
  const { issueNumber, issueTitle, projectId, projectName, reason } = opts;

  // Get users assigned to project (or all users if none assigned)
  let users = userProjectsRepo.getUsersForProject(projectId);
  if (users.length === 0) {
    users = usersRepo.getAll();
  }

  // Notify users with operator or owner roles — triage fallback requires human action
  const operators = users.filter(u => u.role === 'operator' || u.role === 'owner');

  for (const user of operators) {
    try {
      // Skip during quiet hours — triage is important but not blocking
      if (isInQuietHours(user)) {
        console.log(`[user-notifier] Skipping triage.operator_fallback for ${user.name} — quiet hours`);
        continue;
      }

      const message = formatTriageFallbackMessage(issueNumber, issueTitle, projectName, reason);
      await deliverToUser(user, message, {
        event: 'triage.operator_fallback',
        issueNumber,
        issueTitle,
        projectId,
        projectName,
        reason,
      });
    } catch (err: any) {
      console.error(`[user-notifier] Failed to notify operator ${user.name} of triage fallback: ${err.message}`);
    }
  }
}

// ── Delivery ────────────────────────────────────────────────────────

export async function deliverToUser(
  user: ArmadaUser,
  message: string,
  payload: Record<string, any>,
): Promise<TelegramNotification | null> {
  // Get system-configured channels that are enabled
  const enabledChannels = notificationChannelRepo.getEnabled();
  const enabledTypes = new Set(enabledChannels.map(c => c.type));

  const userChannels = user.channels || {};

  let telegramResult: TelegramNotification | null = null;
  const deliveries: Promise<void>[] = [];

  // Telegram — system channel must be enabled + user must have a linked identity
  const telegramId = userChannels.telegram?.platformId;
  if (enabledTypes.has('telegram') && telegramId) {
    const isGate = payload.event === 'workflow.gate';
    deliveries.push(
      sendTelegram(telegramId, message, isGate, payload.runId, payload.stepId).then(msgId => {
        if (msgId !== null) telegramResult = { chatId: telegramId, messageId: msgId };
      })
    );
  }

  // Slack — system channel must be enabled + user must have a linked identity
  const slackId = userChannels.slack?.platformId;
  if (enabledTypes.has('slack') && slackId) {
    const isGate = payload.event === 'workflow.gate';
    const slackMessage = formatForSlack(payload);
    if (isGate && payload.runId && payload.stepId) {
      deliveries.push(sendSlackGateNotification(slackId, slackMessage, payload.runId, payload.stepId));
    } else {
      deliveries.push(sendSlackNotification(slackId, slackMessage));
    }
  }

  // Discord — system channel must be enabled + user must have a linked identity
  const discordId = userChannels.discord?.platformId;
  if (enabledTypes.has('discord') && discordId) {
    const isGate = payload.event === 'workflow.gate';
    if (isGate && payload.runId && payload.stepId) {
      deliveries.push(sendDiscordGateNotification(discordId, message, payload.runId, payload.stepId));
    } else {
      deliveries.push(sendDiscordNotification(discordId, message));
    }
  }

  // Callback URL — operator users, independent of channel system
  // This is always attempted if configured (no system channel check)
  if (user.linkedAccounts?.callbackUrl && user.linkedAccounts?.hooksToken) {
    deliveries.push(sendCallback(user.linkedAccounts.callbackUrl, user.linkedAccounts.hooksToken, payload));
  }

  // Webhook — user must have webhook config; independent of channel system
  const webhookUrl = user.notifications?.webhook?.url;
  if (webhookUrl) {
    deliveries.push(sendWebhook(webhookUrl, (user.notifications?.webhook as any)?.secret, payload));
  }

  // Future channels — same pattern:
  // if (enabledTypes.has('email') && userChannels.email?.platformId) { ... }

  await Promise.allSettled(deliveries);
  return telegramResult;
}

// ── Message formatting ──────────────────────────────────────────────

/** Format a notification payload for Slack using mrkdwn */
function formatForSlack(payload: Record<string, any>): string {
  const { event, workflowName, stepId, runId, previousOutput } = payload;

  if (event === 'workflow.gate') {
    let msg = `⏸️ Workflow *${workflowName}* paused at gate *${stepId}*\n\n\`${runId}\``;
    if (previousOutput) {
      const maxPreview = 3800;
      const preview = previousOutput.length > maxPreview
        ? previousOutput.slice(0, maxPreview) + '...'
        : previousOutput;
      msg += `\n\n*Previous step output:*\n\`\`\`${preview}\`\`\``;
    }
    return msg;
  }

  const status = event?.replace('workflow.', '') ?? 'unknown';
  const emoji = status === 'completed' ? '✅' : '❌';
  return `${emoji} Workflow *${workflowName}* ${status}\n\n\`${runId}\``;
}

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

function formatTriageFallbackMessage(
  issueNumber: number,
  issueTitle: string,
  projectName: string,
  reason: string,
): string {
  return (
    `🔀 <b>Manual triage required</b>\n\n` +
    `Issue <b>#${issueNumber}</b> in project <b>${escapeHtml(projectName)}</b> could not be auto-triaged.\n\n` +
    `<b>Title:</b> ${escapeHtml(issueTitle)}\n` +
    `<b>Reason:</b> ${escapeHtml(reason)}`
  );
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
    const resp = await fetch(`${url}/armada/notify`, {
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
