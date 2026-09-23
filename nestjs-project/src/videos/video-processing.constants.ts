/** Queue and job names of the video processing pipeline (phase-03-videos/TD-01). */
export const VIDEO_PROCESSING = {
  QUEUE: 'video-processing',
  JOB: 'video.process',
} as const;

export interface VideoProcessJobData {
  videoId: string;
}
