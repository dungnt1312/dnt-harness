/**
 * The mini-Cordis kernel surface: event bus, fiber lifecycle, service store,
 * context proxy, service base, kernel registry, and the YAML loader.
 */
export { EventBus, type Events, type DispatchMode, type EventOptions, type WaterfallBoundary } from './events.ts'
export {
  Fiber,
  assertNever,
  type Effect,
  type EffectMeta,
  type FiberState,
} from './fiber.ts'
export { ServiceStore, type ServiceChange } from './store.ts'
export { Context, createContext } from './context.ts'
export { Service } from './service.ts'
export {
  Kernel,
  resolvePlugin,
  type PluginTarget,
  type ResolvedPlugin,
} from './registry.ts'
export {
  boot,
  bootFromFile,
  loadPluginModule,
  parseConfig,
  type ConfigEntry,
} from './loader.ts'
