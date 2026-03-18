/**
 * Notification Service (#512)
 *
 * Sends notifications to all enabled channels when events occur.
 * Channels are persisted in DB (notification_channels table).
 *
 * Supported types:
 *  - telegram:  POST to https://api.telegram.org/bot{token}/sendMessage
 *  - slack:     POST to webhook URL
 *  - discord:   POST to webhook URL
 *  - email:     SMTP via nodemailer (#281)
 */

import nodemailer from 'nodemailer';
import { notificationChannelRepo } from '../repositories/notification-channel-repo.js';
import type { NotificationChannel } from '../repositories/notification-channel-repo.js';

export type NotificationEvent =
  | 'changeset.completed'
  | 'changeset.failed'
  | 'operation.completed'
  | 'operation.failed'
  | 'instance.started'
  | 'instance.stopped'
  | 'instance.upgrade_failed'
  | 'agent.health'
  | string;

export interface NotificationPayload {
  event: NotificationEvent;
  message: string;
  data?: Record<string, unknown>;
}

// ── Channel-specific send helpers ────────────────────────────────────

async function sendTelegram(channel: NotificationChannel, _text: string): Promise<void> {
  const { token } = channel.config as { token?: string };
  if (!token) {
    console.warn(`[notification-service] Telegram channel "${channel.name}" missing token`);
    return;
  }
  // System-level broadcast via a static chat_id is no longer supported.
  // Telegram notifications are delivered per-user via user.channels.telegram.platformId
  // through the user-notifier service. This channel entry only needs a token to indicate
  // that the Telegram bot is enabled for per-user delivery.
}

async function sendSlack(channel: NotificationChannel, text: string): Promise<void> {
  const { webhook_url } = channel.config as { webhook_url?: string };
  if (!webhook_url) {
    console.warn(`[notification-service] Slack channel "${channel.name}" missing webhook_url`);
    return;
  }
  const resp = await fetch(webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.error(`[notification-service] Slack send failed (${resp.status}): ${body}`);
  }
}

async function sendDiscord(channel: NotificationChannel, text: string): Promise<void> {
  const { webhook_url } = channel.config as { webhook_url?: string };
  if (!webhook_url) {
    console.warn(`[notification-service] Discord channel "${channel.name}" missing webhook_url`);
    return;
  }
  const resp = await fetch(webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.error(`[notification-service] Discord send failed (${resp.status}): ${body}`);
  }
}

async function sendEmail(channel: NotificationChannel, text: string): Promise<void> {
  const config = channel.config as {
    smtp_host?: string;
    smtp_port?: string;
    smtp_user?: string;
    smtp_pass?: string;
    from_address?: string;
    to_address?: string;
  };
  const { smtp_host, smtp_port, smtp_user, smtp_pass, from_address, to_address } = config;
  if (!smtp_host || !from_address || !to_address) {
    console.warn(`[notification-service] Email channel "${channel.name}" missing smtp_host, from_address, or to_address`);
    return;
  }
  const transporter = nodemailer.createTransport({
    host: smtp_host,
    port: parseInt(smtp_port ?? '587', 10),
    secure: smtp_port === '465',
    auth: smtp_user && smtp_pass ? { user: smtp_user, pass: smtp_pass } : undefined,
  });
  // Strip HTML tags for plain-text body
  const plainText = text.replace(/<[^>]+>/g, '');
  // Use the event name from the text for the subject
  const subjectMatch = plainText.match(/^[^\n]+/);
  const subject = subjectMatch ? `Armada Alert: ${subjectMatch[0].trim()}` : 'Armada Alert';
  await transporter.sendMail({
    from: from_address,
    to: to_address,
    subject,
    text: plainText,
    html: text,
  });
}

async function sendToChannel(channel: NotificationChannel, text: string): Promise<void> {
  switch (channel.type) {
    case 'telegram': return sendTelegram(channel, text);
    case 'slack':    return sendSlack(channel, text);
    case 'discord':  return sendDiscord(channel, text);
    case 'email':    return sendEmail(channel, text);
    default:
      console.warn(`[notification-service] Unknown channel type: ${(channel as NotificationChannel).type}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Send a notification to all enabled channels.
 *
 * Fire-and-forget by default — individual channel failures are logged but
 * do not propagate. Pass `{ throwOnError: true }` for test/diagnostic use.
 */
export async function sendNotification(
  payload: NotificationPayload,
  opts?: { throwOnError?: boolean },
): Promise<void> {
  const channels = notificationChannelRepo.getEnabled();
  if (channels.length === 0) return;

  const text = formatMessage(payload);

  const tasks = channels.map(ch =>
    sendToChannel(ch, text).catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[notification-service] Failed to send to channel "${ch.name}" (${ch.type}): ${msg}`);
      if (opts?.throwOnError) throw err;
    }),
  );

  await Promise.all(tasks);
}

/**
 * Send a test notification to a single channel by ID.
 * Throws on any error so callers can surface the failure to users.
 */
export async function testChannel(channelId: string): Promise<void> {
  const channel = notificationChannelRepo.findById(channelId);
  if (!channel) throw new Error(`Notification channel "${channelId}" not found`);
  const text = `🔔 <b>Test notification</b>\n\nChannel: ${channel.name}\nType: ${channel.type}\n\nThis is a test from Armada.`;
  await sendToChannel(channel, text);
}

function formatMessage(payload: NotificationPayload): string {
  const icon = eventIcon(payload.event);
  return `${icon} <b>${payload.event}</b>\n${payload.message}`;
}

function eventIcon(event: string): string {
  if (event.includes('fail') || event.includes('error')) return '❌';
  if (event.includes('complet') || event.includes('success')) return '✅';
  if (event.includes('start')) return '🚀';
  if (event.includes('stop') || event.includes('offline')) return '🔴';
  if (event.includes('health')) return '💓';
  return '📢';
}
