import { eventBus } from './event-bus.js';
import { EVENT_NAMES } from './event-names.js';
import { configDiffService } from '../services/config-diff.js';

// Events that trigger a config version bump
const CONFIG_CHANGE_EVENTS = [
  EVENT_NAMES.PROVIDER_CREATED,
  EVENT_NAMES.PROVIDER_UPDATED,
  EVENT_NAMES.PROVIDER_DELETED,
  EVENT_NAMES.PROVIDER_KEY_CREATED,
  EVENT_NAMES.PROVIDER_KEY_UPDATED,
  EVENT_NAMES.PROVIDER_KEY_DELETED,
  EVENT_NAMES.MODEL_CREATED,
  EVENT_NAMES.MODEL_UPDATED,
  EVENT_NAMES.MODEL_DELETED,
  EVENT_NAMES.PLUGIN_INSTALLED,
  EVENT_NAMES.PLUGIN_LIBRARY_UPDATE,
  EVENT_NAMES.PLUGIN_LIBRARY_REMOVE,
  EVENT_NAMES.MUTATION_STAGED,
] as const;

export function initConfigVersionTracker(): void {
  for (const event of CONFIG_CHANGE_EVENTS) {
    eventBus.on(event, () => {
      configDiffService.bumpVersion();
      eventBus.emit(EVENT_NAMES.CONFIG_CHANGED, {});
    });
  }
}
