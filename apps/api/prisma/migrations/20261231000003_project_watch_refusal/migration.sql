-- #691: why the runner's local policy refuses to watch the project.
ALTER TABLE "projects" ADD COLUMN "watchRefusal" TEXT;
