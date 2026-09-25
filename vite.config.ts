import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
	plugins: [
		react(),
		tailwindcss(),
		viteStaticCopy({
			targets: [
				{ src: 'manifest.json', dest: '.' }, // Copies manifest.json to root of dist/
			],
		}),
	],
	build: {
		rollupOptions: {
			input: {
				popup: resolve(import.meta.dirname, 'src/popup/index.html'),
				dashboard: resolve(import.meta.dirname, 'src/dashboard/index.html'),
				background: resolve(import.meta.dirname, 'src/background/index.ts'),
			},
			output: {
				entryFileNames: 'assets/[name].js',
				chunkFileNames: 'assets/[name].js',
				assetFileNames: 'assets/[name].[ext]',
			},
		},
	},
});
