/*
  Warnings:

  - Added the required column `address` to the `notification_message` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "notification_message" ADD COLUMN     "address" TEXT NOT NULL;
