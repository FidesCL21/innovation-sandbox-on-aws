import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["*.ts"],
    },
  },
  resolve: {
    alias: {
      "@amzn/innovation-sandbox-lease-collaborator-assignment": path.resolve(
        __dirname,
        "./src",
      ),
      "@amzn/innovation-sandbox-lease-collaborator-assignment/test": path.resolve(
        __dirname,
        "./test",
      ),
    },
  },
});
