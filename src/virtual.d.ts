declare module "virtual:react-autolocale" {
  export interface LanguageMeta {
    code: string;
    native: string;
    rtl: boolean;
  }
  export const original: string;
  export const originalNative: string;
  /** <AutoScale seo> was set: switching language navigates to the real page. */
  export const seo: boolean;
  /** The language-suggestion banner's phrases in every language. */
  export const banner: Record<string, { prompt: string; switch: string; dismiss: string }>;
  /** Target languages (not including the original). */
  export const languages: LanguageMeta[];
  /** Every language's dictionary, inlined by the dev server so code outside components can read it at load time. */
  export const eager: Record<string, Record<string, string>>;
  export const loaders: Record<string, () => Promise<{ default: Record<string, string> }>>;
}
