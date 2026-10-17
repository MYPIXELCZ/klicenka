import { nextAuthReceiver } from "@mypixel/klicenka/next-auth";
export const POST = nextAuthReceiver({ redirectTo: "/admin", issuer: process.env.KLICENKA_ISSUER });
