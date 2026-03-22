import { createEngine } from "edgplay";
import { ChessRoom } from "./ChessRoom.js";
import { identitySchema } from "../edgplay.config.js";

const engine = createEngine()
  .register("chess", ChessRoom)
  .defineIdentity(identitySchema)
  // Uncomment to enable D1 persistence — use any binding name you want:
  // .withDatabase(env => env.CHESS_DB)
  .onConnect(async (player, req) => {
    const url  = new URL(req.url);
    const name = url.searchParams.get("name")?.trim().slice(0, 32) || "Anonymous";

    await player.identify({
      public:  { name },
      private: {},
    });
  });

export default engine.worker;
export const { GameRoom, LobbyDO } = engine.durableObjects;
