export type Context = {
    webpack: boolean;
    esbuild: boolean;
    tests: boolean;
    name: string;
};

export type File = {
    name: string;
    condition?: (context: Context) => boolean;
    content: (context: Context) => string;
};

export type Plugin = {
    name: string;
    location: string;
};
