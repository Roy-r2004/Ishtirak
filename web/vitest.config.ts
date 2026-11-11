import { defineConfig } from 'vitest/config'

// The archived Switchboard code (archive-switchboard/) is kept for reference only and is not part of the build or the test run.
export default defineConfig({ test: { exclude: ['archive-switchboard/**', 'node_modules/**', 'dist/**', 'preview/**'] } })
