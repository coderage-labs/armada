import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createEventBus } from '../event-bus.js';

describe('EventBus', () => {
  let bus: ReturnType<typeof createEventBus>;

  beforeEach(() => {
    bus = createEventBus();
  });

  describe('emit + on', () => {
    it('delivers events to exact match subscribers', () => {
      const events: any[] = [];
      bus.on('test.event', e => events.push(e));
      bus.emit('test.event', { foo: 'bar' });
      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({ foo: 'bar' });
      expect(events[0].event).toBe('test.event');
    });

    it('does not deliver to non-matching subscribers', () => {
      const events: any[] = [];
      bus.on('other.event', e => events.push(e));
      bus.emit('test.event', { foo: 'bar' });
      expect(events).toHaveLength(0);
    });

    it('supports wildcard subscriptions', () => {
      const events: any[] = [];
      bus.on('test.*', e => events.push(e));
      bus.emit('test.one', { a: 1 });
      bus.emit('test.two', { a: 2 });
      bus.emit('other.thing', { a: 3 });
      expect(events).toHaveLength(2);
    });

    it('supports global wildcard', () => {
      const events: any[] = [];
      bus.on('*', e => events.push(e));
      bus.emit('anything', { a: 1 });
      bus.emit('something.else', { a: 2 });
      expect(events).toHaveLength(2);
    });

    it('unsubscribes when dispose is called', () => {
      const events: any[] = [];
      const unsub = bus.on('test', e => events.push(e));
      bus.emit('test', { a: 1 });
      unsub();
      bus.emit('test', { a: 2 });
      expect(events).toHaveLength(1);
    });

    it('assigns incrementing IDs', () => {
      const events: any[] = [];
      bus.on('*', e => events.push(e));
      bus.emit('a', {});
      bus.emit('b', {});
      bus.emit('c', {});
      expect(events[0].id).toBe(1);
      expect(events[1].id).toBe(2);
      expect(events[2].id).toBe(3);
    });

    it('includes timestamp on events', () => {
      const events: any[] = [];
      bus.on('test', e => events.push(e));
      const before = Date.now();
      bus.emit('test', {});
      const after = Date.now();
      expect(events[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(events[0].timestamp).toBeLessThanOrEqual(after);
    });

    it('handles multiple subscribers for same event', () => {
      const a: any[] = [];
      const b: any[] = [];
      bus.on('test', e => a.push(e));
      bus.on('test', e => b.push(e));
      bus.emit('test', { x: 1 });
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it('does not crash if handler throws', () => {
      bus.on('test', () => { throw new Error('boom'); });
      const events: any[] = [];
      bus.on('test', e => events.push(e));
      bus.emit('test', { ok: true });
      expect(events).toHaveLength(1);
    });

    it('logs a console.error when a handler throws', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      bus.on('config.changed', () => { throw new Error('handler failed'); });
      bus.emit('config.changed', {});
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0]).toMatch(/\[event-bus\] Handler error on 'config\.changed': handler failed/);
      spy.mockRestore();
    });

    it('calls registered onError handlers when a subscriber throws', () => {
      const errors: Array<{ eventName: string; error: unknown }> = [];
      bus.onError((eventName, error) => errors.push({ eventName, error }));
      bus.on('test', () => { throw new Error('oops'); });
      bus.emit('test', {});
      expect(errors).toHaveLength(1);
      expect(errors[0].eventName).toBe('test');
      expect(errors[0].error).toBeInstanceOf(Error);
    });

    it('onError returns an unsubscribe function', () => {
      const errors: unknown[] = [];
      const unsub = bus.onError((_name, err) => errors.push(err));
      bus.on('test', () => { throw new Error('x'); });
      bus.emit('test', {});
      expect(errors).toHaveLength(1);
      unsub();
      bus.emit('test', {});
      expect(errors).toHaveLength(1); // no new errors after unsubscribe
    });
  });

  describe('once', () => {
    it('fires only once', () => {
      const events: any[] = [];
      bus.once('test', e => events.push(e));
      bus.emit('test', { a: 1 });
      bus.emit('test', { a: 2 });
      expect(events).toHaveLength(1);
    });

    it('returns unsubscribe function', () => {
      const events: any[] = [];
      const unsub = bus.once('test', e => events.push(e));
      unsub();
      bus.emit('test', { a: 1 });
      expect(events).toHaveLength(0);
    });
  });

  describe('replay', () => {
    it('replays events after a given ID (exclusive)', () => {
      bus.emit('a', { n: 1 });
      bus.emit('b', { n: 2 });
      bus.emit('c', { n: 3 });

      // replay(2) returns events with id > 2
      const replayed = bus.replay(2);
      expect(replayed).toHaveLength(1);
      expect(replayed[0].id).toBe(3);
    });

    it('replays events from a given ID (inclusive when using id-1)', () => {
      bus.emit('a', { n: 1 });
      bus.emit('b', { n: 2 });
      bus.emit('c', { n: 3 });

      // replay(1) returns events with id > 1
      const replayed = bus.replay(1);
      expect(replayed).toHaveLength(2);
      expect(replayed[0].id).toBe(2);
      expect(replayed[1].id).toBe(3);
    });

    it('replays all events from ID 0', () => {
      bus.emit('a', { n: 1 });
      bus.emit('b', { n: 2 });
      const replayed = bus.replay(0);
      expect(replayed).toHaveLength(2);
    });

    it('replays with event filter', () => {
      bus.emit('a.one', { n: 1 });
      bus.emit('b.one', { n: 2 });
      bus.emit('a.two', { n: 3 });

      const replayed = bus.replay(0, 'a.*');
      expect(replayed).toHaveLength(2);
      expect(replayed[0].event).toBe('a.one');
      expect(replayed[1].event).toBe('a.two');
    });

    it('handles ring buffer wraparound', () => {
      for (let i = 0; i < 2100; i++) {
        bus.emit('test', { n: i });
      }
      const replayed = bus.replay(1);
      expect(replayed.length).toBeLessThanOrEqual(2000);
      expect(replayed[replayed.length - 1].data.n).toBe(2099);
    });

    it('returns empty for future IDs', () => {
      bus.emit('test', {});
      const replayed = bus.replay(999);
      expect(replayed).toHaveLength(0);
    });
  });

  describe('getLastId', () => {
    it('returns 0 when no events emitted', () => {
      expect(bus.getLastId()).toBe(0);
    });

    it('returns latest event ID', () => {
      bus.emit('a', {});
      bus.emit('b', {});
      expect(bus.getLastId()).toBe(2);
    });
  });
});
