import { type InboundHookAccepted, WEBHOOK_HEADERS } from '@agentdock/shared';
import { Controller, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../auth';
import type { RawBodyRequest } from '../common';
import { InboundHookService } from './inbound-hook.service';
import { TriggerFirer } from './trigger-firer';

/**
 * `POST /hooks/:publicId` (spec 26 D1–D7): the one public webhooks route.
 * Signed, rate limited, and answered 202 before anything is sent to a runner.
 */
@Controller('hooks')
export class HooksController {
  constructor(
    private readonly hooks: InboundHookService,
    private readonly firer: TriggerFirer,
  ) {}

  @Public()
  @Post(':publicId')
  @HttpCode(202)
  async receive(
    @Param('publicId') publicId: string,
    @Req() req: Request & RawBodyRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InboundHookAccepted | undefined> {
    const received = await this.hooks.receive({
      publicId,
      rawBody: req.rawBody,
      timestamp: req.get(WEBHOOK_HEADERS.timestamp),
      deliveryId: req.get(WEBHOOK_HEADERS.delivery),
      signature: req.get(WEBHOOK_HEADERS.signature),
      sourceIp: req.ip ?? null,
    });
    if (!received) {
      // D1: an unknown and a disabled trigger look alike, and say nothing.
      res.status(404);
      return undefined;
    }
    // D7: the caller never waits for an agent.
    if (received.fire) this.firer.schedule(received.fire);
    return received.answer;
  }
}
