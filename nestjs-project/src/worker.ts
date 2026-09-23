import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './videos/worker.module';

/**
 * Entrypoint of the `video-worker` container (phase-03-videos/TD-06).
 *
 * An application context — no HTTP server — so video processing never competes
 * with API requests. Shutdown hooks let BullMQ finish the job in flight before
 * the process exits (library-refs.md → bullmq).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  Logger.log('Video worker is consuming the processing queue', 'Worker');
}

void bootstrap();
