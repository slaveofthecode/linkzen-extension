import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
	plugins: [react(), tailwindcss()],
	build: {
		rollupOptions: {
			input: {
				popup: resolve(__dirname, 'src/popup/index.html'),
				dashboard: resolve(__dirname, 'src/dashboard/index.html'),
			},
			output: {
				entryFileNames: 'assets/[name].js',
				chunkFileNames: 'assets/[name].js',
				assetFileNames: 'assets/[name].[ext]',
			},
		},
	},
});
