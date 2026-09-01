/** PRIVACY.md is bundled into the Worker via the wrangler `rules` Text loader. */
declare module "*.md" {
  const content: string;
  export default content;
}
