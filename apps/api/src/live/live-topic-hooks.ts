import {
  type LiveErrorCode,
  type LiveTopic,
  type LiveTopicPrefix,
  parseLiveTopic,
} from '@agentdock/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { LiveClient } from './live-connections';

/**
 * What a domain module does when sockets come and go on its topics — the pane
 * relay (spec 18) starts and stops a runner stream on them. `admit` runs after
 * the topic was authorized; `joined` / `left` run for every way a socket gets
 * on or off a topic: subscribe, unsubscribe, close, idle drop, session end,
 * re-validation. They must not throw; work they start is their own to queue.
 */
export interface LiveTopicHooks {
  /** A code refuses the subscription; `subscribers` excludes the new socket. */
  admit?(topic: LiveTopic, subscribers: number): LiveErrorCode | null;
  joined?(client: LiveClient, topic: LiveTopic): void;
  left?(client: LiveClient, topic: LiveTopic): void;
}

/** The hooks of each topic prefix; a prefix without hooks has nothing to run. */
@Injectable()
export class LiveTopicHookRegistry {
  private readonly logger = new Logger(LiveTopicHookRegistry.name);
  private readonly hooks = new Map<LiveTopicPrefix, LiveTopicHooks>();

  register(prefix: LiveTopicPrefix, hooks: LiveTopicHooks): void {
    if (this.hooks.has(prefix)) {
      throw new Error(`live topic prefix "${prefix}" already has hooks`);
    }
    this.hooks.set(prefix, hooks);
  }

  admit(topic: LiveTopic, subscribers: number): LiveErrorCode | null {
    return this.of(topic)?.admit?.(topic, subscribers) ?? null;
  }

  joined(client: LiveClient, topic: LiveTopic): void {
    this.run('joined', topic, (hooks) => hooks.joined?.(client, topic));
  }

  left(client: LiveClient, topic: LiveTopic): void {
    this.run('left', topic, (hooks) => hooks.left?.(client, topic));
  }

  private of(topic: LiveTopic): LiveTopicHooks | undefined {
    return this.hooks.get(parseLiveTopic(topic).prefix);
  }

  /** A failing hook is logged, never allowed to break the socket's bookkeeping. */
  private run(
    name: string,
    topic: LiveTopic,
    call: (hooks: LiveTopicHooks) => void,
  ): void {
    const hooks = this.of(topic);
    if (!hooks) return;
    try {
      call(hooks);
    } catch (error) {
      this.logger.error(
        `live topic hook ${name} on ${topic} failed: ${(error as Error).message}`,
      );
    }
  }
}
