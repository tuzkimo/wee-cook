-- 回滚 001_init：按依赖倒序删表。
-- 不删 uuid-ossp 扩展：它可能被同一库里的其它 schema 共用，删它超出本次迁移的范围。
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS labels;
DROP TABLE IF EXISTS units;
DROP TABLE IF EXISTS ingredients;
DROP TABLE IF EXISTS recipe_labels;
DROP TABLE IF EXISTS recipe_ingredients;
DROP TABLE IF EXISTS recipe_steps;
DROP TABLE IF EXISTS recipes;
DROP TABLE IF EXISTS team_members;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS users;
DROP SEQUENCE IF EXISTS global_server_seq;
