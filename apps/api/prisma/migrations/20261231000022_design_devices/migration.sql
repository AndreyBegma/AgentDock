-- #863 (ADR-0085): the devices a design is drawn for, copied at Generate.
-- AlterTable
ALTER TABLE "task_designs" ADD COLUMN "devices" JSONB;
