import { createServer } from "vite";

const entry = "/src/screens/project-environment/preview.html";
const server = await createServer({
  server: {
    host: "127.0.0.1", port: 5178, strictPort: true,
    watch: { ignored: ["**/.integration-staging/**", "**/versions/**", "**/data/**", "**/release/**", "**/release-staging/**", "**/dist/**"] },
  },
  plugins: [{
    name: "project-environment-preview-entry",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if ((request.url ?? "").split("?")[0] !== "/") { next(); return; }
        response.statusCode = 302;
        response.setHeader("Location", entry);
        response.end();
      });
    },
  }],
});
await server.listen();
console.log("AutoResearch Conda environment preview: http://127.0.0.1:5178/");
console.log("Preview only: no Conda commands, API calls, or research data changes.");

