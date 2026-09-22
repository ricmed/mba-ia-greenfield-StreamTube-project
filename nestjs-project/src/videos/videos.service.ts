import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { Video } from './entities/video.entity';
import { persistWithUniquePublicId } from './public-id.util';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
  ) {}

  /**
   * Saves a video assigning an unguessable `public_id`, retrying on unique
   * violation (phase-03-videos/TD-09).
   */
  async saveWithUniquePublicId(
    video: Omit<Partial<Video>, 'public_id'>,
  ): Promise<Video> {
    return persistWithUniquePublicId((public_id) =>
      this.videoRepository.save(
        this.videoRepository.create({ ...video, public_id }),
      ),
    );
  }

  async findByPublicIdOrFail(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ public_id: publicId });
    if (!video) throw new VideoNotFoundException();
    return video;
  }
}
