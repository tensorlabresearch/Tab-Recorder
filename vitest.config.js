import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{js,mjs}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      include: [
        'extension/service_worker.js',
        'extension/panel.js',
        'extension/lib/utils.js',
        'extension/lib/fileStorage.js',
        'extension/lib/audioFs.js',
        'extension/lib/browserAi.js',
        'extension/lib/sessionMerge.js',
        'extension/lib/transcriptionChunks.js',
        'extension/lib/transcriptParser.js',
        'extension/lib/summaryFile.js',
        'extension/lib/mp3Encoding.js',
        'extension/lib/whisperModel.js',
        'extension/lib/utteranceSegmenter.js',
        'extension/lib/embeddingCluster.js',
        'extension/lib/diarizedTranscript.js',
        'extension/lib/webmOpusDecoder.js',
        'extension/lib/speakerEmbedModel.js',
      ],
      exclude: [
        'extension/lib/transformersJs/**',
        'extension/lib/lamejs/**',
        'extension/lib/whisperWorker.js',
        'extension/lib/diarizationWorker.js',
        'extension/lib/mp3Worker.js',
        'extension/lib/diarizationWorkerClient.js',
      ],
      thresholds: {
        statements: 50,
        branches: 40,
        functions: 45,
        lines: 50,
      },
    },
  },
});
