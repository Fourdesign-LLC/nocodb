import path from 'path';
import { Readable } from 'stream';
import { Logger } from '@nestjs/common';
import slash from 'slash';
import type { IStorageAdapterV2 } from '~/types/nc-plugin';
import type { Job } from 'bull';
import type { AttachmentResType } from 'nocodb-sdk';
import type { ThumbnailGeneratorJobData } from '~/interface/Jobs';
import type Sharp from 'sharp';
import NcPluginMgrv2 from '~/helpers/NcPluginMgrv2';
import { getPathFromUrl } from '~/helpers/attachmentHelpers';

export class ThumbnailGeneratorProcessor {
  private logger = new Logger(ThumbnailGeneratorProcessor.name);

  async job(job: Job<ThumbnailGeneratorJobData>) {
    const { attachments } = job.data;

    const results = [];

    for (const attachment of attachments) {
      const thumbnail = await this.generateThumbnail(attachment);

      if (!thumbnail) {
        continue;
      }

      results.push({
        path: attachment.path ?? attachment.url,
        card_cover: thumbnail?.card_cover,
        small: thumbnail?.small,
        tiny: thumbnail?.tiny,
      });
    }

    return results;
  }

  private async generateThumbnail(
    attachment: AttachmentResType,
  ): Promise<{ [key: string]: string }> {
    let sharp: typeof Sharp;

    try {
      sharp = (await import('sharp')).default;
    } catch {
      // ignore
    }

    if (!sharp) {
      this.logger.warn(
        `Thumbnail generation is not supported in this platform at the moment.`,
      );
      return;
    }

    sharp.concurrency(1);

    try {
      const storageAdapter = await NcPluginMgrv2.storageAdapter();

      const { file, relativePath } = await this.getFileData(
        attachment,
        storageAdapter,
      );

      const thumbnailPaths = {
        card_cover: path.join(
          'nc',
          'thumbnails',
          relativePath,
          'card_cover.jpg',
        ),
        small: path.join('nc', 'thumbnails', relativePath, 'small.jpg'),
        tiny: path.join('nc', 'thumbnails', relativePath, 'tiny.jpg'),
      };

      const sharpImage = await sharp(file, {
        limitInputPixels: false,
      });

      for (const [size, thumbnailPath] of Object.entries(thumbnailPaths)) {
        let height;
        switch (size) {
          case 'card_cover':
            height = 512;
            break;
          case 'small':
            height = 128;
            break;
          case 'tiny':
            height = 64;
            break;
          default:
            height = 32;
            break;
        }

        const resizedImage = await sharpImage
          .resize(undefined, height, {
            fit: sharp.fit.cover,
            kernel: 'lanczos3',
          })
          .toBuffer();

        await (storageAdapter as any).fileCreateByStream(
          slash(thumbnailPath),
          Readable.from(resizedImage),
          {
            mimetype: 'image/jpeg',
          },
        );
      }

      return thumbnailPaths;
    } catch (error) {
      this.logger.error({
        message: `Failed to generate thumbnails for ${
          attachment.path ?? attachment.url
        }`,
        error: error?.message,
      });

      return null;
    }
  }

  private async getFileData(
    attachment: AttachmentResType,
    storageAdapter: IStorageAdapterV2,
  ): Promise<{ file: Buffer; relativePath: string }> {
    let relativePath;

    if (attachment.path) {
      relativePath = path.join(
        'nc',
        'uploads',
        attachment.path.replace(/^download\//, ''),
      );
    } else if (attachment.url) {
      relativePath = getPathFromUrl(attachment.url).replace(/^\/+/, '');
    }

    const file = await storageAdapter.fileRead(relativePath);

    // remove everything before 'nc/uploads/' (including nc/uploads/) in relativePath
    relativePath = relativePath.replace(/.*?nc\/uploads\//, '');

    return { file, relativePath };
  }
}
