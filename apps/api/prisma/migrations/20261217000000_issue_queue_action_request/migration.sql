-- C-112: a session's issue waits for a person before the fleet may take it.
ALTER TYPE "ActionRequestKind" ADD VALUE 'issue_queue';
