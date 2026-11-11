-- v7: probe and archive source video metadata (resolution, frame count).
ALTER TABLE local_media_video ADD COLUMN width INTEGER;
ALTER TABLE local_media_video ADD COLUMN height INTEGER;
ALTER TABLE local_media_video ADD COLUMN frame_count INTEGER;
