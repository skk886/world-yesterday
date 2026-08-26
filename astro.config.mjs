import { defineConfig } from "astro/config";

const repository = process.env.GITHUB_REPOSITORY?.split("/")[1];
const owner = process.env.GITHUB_REPOSITORY?.split("/")[0];
const isUserSite = repository && owner && repository.toLowerCase() === `${owner.toLowerCase()}.github.io`;
const base = process.env.BASE_PATH ?? (repository && !isUserSite ? `/${repository}` : "/");
const site = process.env.SITE_URL ?? (owner ? `https://${owner}.github.io` : "http://localhost:4321");

export default defineConfig({
  output: "static",
  site,
  base,
  trailingSlash: "always",
  build: {
    format: "directory"
  }
});
