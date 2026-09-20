import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "../../shared/const.js";
import { isOwnerAccount } from "../../shared/owners.js";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);

/**
 * The moderation console, which is narrower than admin.
 *
 * Admin says what an account may do; this says who. Suspending a person, a channel or a group is
 * destructive and hard to undo from the other side, and "role = admin" is a grant that can be
 * produced by accident - a seeded account, a column set to the wrong value. The names it accepts
 * are written down in shared/owners.ts.
 *
 * This is the check that matters. The app hides the console from anybody else as well, but that is
 * only so nobody is offered a button that would be refused; the refusal is here, where it cannot be
 * edited from a browser.
 */
export const ownerProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;

    // Split in two rather than one `isOwnerAccount` call for the sake of the type: testing the
    // session before the name is what narrows `ctx.user` from nullable to a user for everything
    // downstream, and it keeps "you are not signed in" distinct from "you are not one of these two".
    if (!ctx.user) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    }

    if (!isOwnerAccount(ctx.user)) {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
