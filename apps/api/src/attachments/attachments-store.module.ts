import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AttachmentStore, FsAttachmentStore } from './attachment-store';
import { ATTACHMENTS_OPTIONS, attachmentsOptions } from './attachments-options';

/**
 * D2: the options and the `AttachmentStore` port bound to the filesystem
 * implementation — a module of its own, so the upload route's multer
 * options can be built from the store too.
 */
@Module({
  providers: [
    {
      provide: ATTACHMENTS_OPTIONS,
      inject: [ConfigService],
      useFactory: attachmentsOptions,
    },
    { provide: AttachmentStore, useClass: FsAttachmentStore },
  ],
  exports: [ATTACHMENTS_OPTIONS, AttachmentStore],
})
export class AttachmentsStoreModule {}
