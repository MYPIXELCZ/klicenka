import { statusResponse } from "@mypixel/klicenka";
import { toPagesHandler } from "@mypixel/klicenka/next";
export default toPagesHandler(async () => statusResponse("next-auth-v4"));
