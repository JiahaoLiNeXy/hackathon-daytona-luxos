import {defineConfig} from 'vite';
import {obstacleApiPlugin} from './server/obstacle-api.mjs';
export default defineConfig({base:'./',plugins:[obstacleApiPlugin()]});
