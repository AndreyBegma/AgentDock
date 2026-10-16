import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

/** An issue a card may name: open, in the project's repository. */
export interface IssueLink {
  number: number;
  url: string;
}

/**
 * #447 D8: a card links only to an open issue of its own project's
 * repository — checked against the project's issue mirror (`issue_caches`,
 * fed by the runner's `gh`), as the queue reads it. A pull request, a
 * closed issue, or a number the mirror does not hold is refused with 422.
 * The board's `PATCH /board/cards/:n` calls it before it stores the link;
 * a linked card's Run then creates no issue and its PR says `Closes #n`.
 */
@Injectable()
export class IssueLinkValidator {
  constructor(private readonly prisma: PrismaService) {}

  async assertLinkable(projectId: string, number: number): Promise<IssueLink> {
    const issue = await this.prisma.issueCache.findUnique({
      where: { projectId_number: { projectId, number } },
      select: { number: true, url: true, state: true, kind: true },
    });
    if (!issue || issue.kind !== 'issue') {
      throw new UnprocessableEntityException(
        `#${number} is not an issue of this project's repository`,
      );
    }
    if (issue.state !== 'open') {
      throw new UnprocessableEntityException(`Issue #${number} is closed`);
    }
    return { number: issue.number, url: issue.url };
  }
}
