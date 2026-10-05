// Runs inside a Linux pen (as `node -e`): the pen has no network, so this listens
// on its localhost and hands each connection to fence's proxy through the unix
// socket bound in, then runs the shell. Plain JavaScript on purpose: it has to
// run with any Node, from wherever fence is installed.
//   node -e <this> -- <port> <proxy socket> <command...>
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";

const [port, socket, ...command] = process.argv.slice(1);

const server = createServer((client) => {
  const upstream = createConnection(socket);
  client.pipe(upstream).pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
});

server.listen(Number(port), "127.0.0.1", () => {
  const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
  for (const sig of ["SIGINT", "SIGQUIT", "SIGTSTP"]) process.on(sig, () => {});
  for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
  child.on("exit", (code, sig) => process.exit(code ?? (sig ? 128 : 1)));
  child.on("error", (err) => {
    console.error(`fence: couldn't start ${command[0]}: ${err.message}`);
    process.exit(127);
  });
});
server.on("error", (err) => {
  console.error(`fence: the network bridge couldn't start: ${err.message}`);
  process.exit(1);
});
