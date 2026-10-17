import { toPagesHandler } from "@mypixel/klicenka/next";
import { nextAuthReceiver } from "@mypixel/klicenka/next-auth";
export default toPagesHandler(nextAuthReceiver({ redirectTo: "/admin", issuer: process.env.KLICENKA_ISSUER }));
