import { expect, test } from "bun:test";
import Adw from "gi://Adw?version=1";
import { Avatars, PIXEL } from "./avatars";
import { useDisplay } from "./testing";

useDisplay();

const avatar = (size: number, text: string) => new Adw.Avatar({ size, text, showInitials: true });

const size = (avatar: Adw.Avatar) => {
  const image = avatar.get_custom_image();
  return image && [image.get_intrinsic_width(), image.get_intrinsic_height()];
};

test("asks once per sender and fills every row showing it", () => {
  const asked: string[] = [];
  const avatars = new Avatars((email) => asked.push(email));
  const list = avatar(40, "Ada");
  const card = avatar(32, "Ada");
  avatars.attach(list, "ada@example.com");
  avatars.attach(card, "ada@example.com");
  avatars.attach(avatar(40, "Nobody"), "");
  expect(asked).toEqual(["ada@example.com"]);
  expect(list.get_custom_image()).toBeNull();

  avatars.resolved("ada@example.com", PIXEL);
  expect(size(list)).toEqual([80, 80]);
  expect(size(card)).toEqual([64, 64]);

  const rebuilt = avatar(40, "Ada");
  avatars.attach(rebuilt, "ada@example.com");
  expect(size(rebuilt)).toEqual(size(list));
  expect(asked).toHaveLength(1);

  const grace = avatar(40, "Grace");
  avatars.attach(grace, "grace@example.com");
  avatars.resolved("grace@example.com", null);
  avatars.attach(grace, "grace@example.com");
  expect(grace.get_custom_image()).toBeNull();
  expect(asked).toHaveLength(2);

  const broken = avatar(40, "Broken");
  avatars.attach(broken, "broken@example.com");
  avatars.resolved("broken@example.com", new TextEncoder().encode("<html>"));
  expect(broken.get_custom_image()).toBeNull();
});
