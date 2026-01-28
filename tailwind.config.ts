import type { Config } from "tailwindcss";

const config: Config = {
    content: [
        "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    theme: {
        extend: {
            colors: {
                primary: {
                    DEFAULT: '#135bec',
                    foreground: '#ffffff',
                    hover: '#1a6af7',
                    alpha: 'rgba(19, 91, 236, 0.15)',
                },
                background: {
                    dark: '#101622',
                    light: '#f6f6f8',
                },
                border: {
                    dark: '#2d3748',
                }
            },
            fontFamily: {
                sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
                mono: ['var(--font-mono)', 'monospace'],
                display: ['var(--font-inter)', 'system-ui', 'sans-serif'],
            },
            borderRadius: {
                lg: "var(--radius)",
                md: "calc(var(--radius) - 2px)",
                sm: "calc(var(--radius) - 4px)",
            },
        },
    },
    plugins: [],
};
export default config;
