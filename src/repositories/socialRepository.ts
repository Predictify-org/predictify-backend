  
  
/* eslint-disable @typescript-eslint/no-explicit-any */ 
import { and, eq, sql } from "drizzle-orm";
import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { db } from "../db/client";
import { AppError } from "../errors/AppError";

const usersTable = pgTable("users", {
  id: uuid("id").notNull(),
  stellarAddress: text("stellar_address").notNull(),
  isPrivate: boolean("is_private").notNull(),
  followersCount: integer("followers_count").notNull(),
  followingCount: integer("following_count").notNull(),
});

const userFollowsTable = pgTable(
  "user_follows",
  {
    followerUserId: uuid("follower_user_id").notNull(),
    targetUserId: uuid("target_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table: any) => ({
    pk: primaryKey({ columns: [table.followerUserId, table.targetUserId] }),
  }),
);

export interface SocialState {
  targetAddress: string;
  isFollowing: boolean;
  visibility: {
    isPrivate: boolean;
    feedVisible: boolean;
  };
  counts: {
    followers: number;
    following: number;
  };
}

interface UserIdentity {
  id: string;
  stellarAddress: string;
  isPrivate: boolean;
  followersCount: number;
  followingCount: number;
}

export interface SocialRepository {
  followUser(actorAddress: string, targetAddress: string): Promise<SocialState>;
  unfollowUser(
    actorAddress: string,
    targetAddress: string,
  ): Promise<SocialState>;
}

export class DrizzleSocialRepository implements SocialRepository {
  constructor(private readonly database: any = db) {}

  async followUser(
    actorAddress: string,
    targetAddress: string,
  ): Promise<SocialState> {
    if (actorAddress === targetAddress) {
      throw new AppError(
        "validation_error",
        "Users cannot follow themselves",
        400,
      );
    }

    return this.database.transaction(async (tx: any) => {
      const actor = await this.loadUser(tx, actorAddress);
      const target = await this.loadUser(tx, targetAddress);

      if (actor.id === target.id) {
        throw new AppError(
          "validation_error",
          "Users cannot follow themselves",
          400,
        );
      }

      if (target.isPrivate) {
        throw new AppError("forbidden", "Target user has a private feed", 403);
      }

      const inserted = await tx
        .insert(userFollowsTable)
        .values({
          followerUserId: actor.id,
          targetUserId: target.id,
          createdAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ followerUserId: userFollowsTable.followerUserId });

      if (inserted.length > 0) {
        await Promise.all([
          tx
            .update(usersTable)
            .set({ followingCount: sql`${usersTable.followingCount} + 1` })
            .where(eq(usersTable.id, actor.id)),
          tx
            .update(usersTable)
            .set({ followersCount: sql`${usersTable.followersCount} + 1` })
            .where(eq(usersTable.id, target.id)),
        ]);
      }

      return this.loadSocialState(tx, actor.id, target.id, targetAddress);
    });
  }

  async unfollowUser(
    actorAddress: string,
    targetAddress: string,
  ): Promise<SocialState> {
    if (actorAddress === targetAddress) {
      throw new AppError(
        "validation_error",
        "Users cannot unfollow themselves",
        400,
      );
    }

    return this.database.transaction(async (tx: any) => {
      const actor = await this.loadUser(tx, actorAddress);
      const target = await this.loadUser(tx, targetAddress);

      const removed = await tx
        .delete(userFollowsTable)
        .where(
          and(
            eq(userFollowsTable.followerUserId, actor.id),
            eq(userFollowsTable.targetUserId, target.id),
          ),
        )
        .returning({ followerUserId: userFollowsTable.followerUserId });

      if (removed.length > 0) {
        await Promise.all([
          tx
            .update(usersTable)
            .set({
              followingCount: sql`GREATEST(${usersTable.followingCount} - 1, 0)`,
            })
            .where(eq(usersTable.id, actor.id)),
          tx
            .update(usersTable)
            .set({
              followersCount: sql`GREATEST(${usersTable.followersCount} - 1, 0)`,
            })
            .where(eq(usersTable.id, target.id)),
        ]);
      }

      return this.loadSocialState(tx, actor.id, target.id, targetAddress);
    });
  }

  private async loadUser(
    database: any,
    stellarAddress: string,
  ): Promise<UserIdentity> {
    const [user] = await database
      .select({
        id: usersTable.id,
        stellarAddress: usersTable.stellarAddress,
        isPrivate: usersTable.isPrivate,
        followersCount: usersTable.followersCount,
        followingCount: usersTable.followingCount,
      })
      .from(usersTable)
      .where(eq(usersTable.stellarAddress, stellarAddress))
      .limit(1);

    if (!user) {
      throw AppError.notFound("User not found");
    }

    return user;
  }

  private async loadSocialState(
    database: any,
    actorId: string,
    targetId: string,
    targetAddress: string,
  ): Promise<SocialState> {
    const [target] = await database
      .select({
        stellarAddress: usersTable.stellarAddress,
        isPrivate: usersTable.isPrivate,
        followersCount: usersTable.followersCount,
        followingCount: usersTable.followingCount,
      })
      .from(usersTable)
      .where(eq(usersTable.id, targetId))
      .limit(1);

    if (!target) {
      throw AppError.notFound("User not found");
    }

    const followRow = await database.execute(sql`
      SELECT 1
      FROM user_follows
      WHERE follower_user_id = ${actorId}::uuid
        AND target_user_id = ${targetId}::uuid
      LIMIT 1
    `);

    const isFollowing = followRow.rows.length > 0;

    return {
      targetAddress: target.stellarAddress ?? targetAddress,
      isFollowing,
      visibility: {
        isPrivate: target.isPrivate,
        feedVisible: !target.isPrivate,
      },
      counts: {
        followers: Number(target.followersCount ?? 0),
        following: Number(target.followingCount ?? 0),
      },
    };
  }
}

export const socialRepository: SocialRepository = new DrizzleSocialRepository();
