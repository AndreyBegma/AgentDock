import {
  type LiveTopic,
  type LiveTopicPrefix,
  parseLiveTopic,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth';

/**
 * Whether `user` may read `topic`. `id` is the part after the prefix (null
 * for `admin`). May query the database — #10's membership check will.
 */
export type TopicAuthorizer = (
  user: AuthUser,
  id: string | null,
  topic: LiveTopic,
) => boolean | Promise<boolean>;

export type TopicDecision = 'allowed' | 'forbidden' | 'unknown_topic';

const adminOnly: TopicAuthorizer = (user) => user.role === 'admin';

/**
 * Maps a topic prefix to the check that guards it (spec D11). A prefix with
 * no authorizer is `unknown_topic` — `project:` until #10 registers one.
 */
@Injectable()
export class TopicAuthorizerRegistry {
  private readonly authorizers = new Map<LiveTopicPrefix, TopicAuthorizer>();

  constructor() {
    this.register('admin', adminOnly);
    this.register('runner', adminOnly);
    this.register('user', (user, id) => user.id === id);
  }

  register(prefix: LiveTopicPrefix, authorize: TopicAuthorizer): void {
    if (this.authorizers.has(prefix)) {
      throw new Error(
        `live topic prefix "${prefix}" already has an authorizer`,
      );
    }
    this.authorizers.set(prefix, authorize);
  }

  async decide(user: AuthUser, topic: LiveTopic): Promise<TopicDecision> {
    const { prefix, id } = parseLiveTopic(topic);
    const authorize = this.authorizers.get(prefix);
    if (!authorize) return 'unknown_topic';
    return (await authorize(user, id, topic)) ? 'allowed' : 'forbidden';
  }
}
