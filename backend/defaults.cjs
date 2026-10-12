"use strict";
const names = [
  "Женская стрижка",
  "Детская стрижка (женский зал)",
  "Окрашивание в один тон",
  "Омбре / Шатуш / Балаяж",
  "Тонировка",
  "Укладка",
  "Локоны",
  "Причёска",
  "Мужская стрижка",
  "Детская стрижка (мужской зал)",
  "Модельная стрижка",
  "Свадебный образ",
];
const prices = [
  4000, 3500, 6000, 25000, 10000, 4000, 5000, 6000, 3000, 2500, 3000, 12000,
];
const services = names.map((name, i) => ({
  id: "service-" + (i + 1),
  name,
  price: prices[i],
  duration: i === 2 ? 60 : 30,
  active: true,
}));
const all = services.map((s) => s.id);
module.exports = {
  name: "Салон красоты «11»",
  address: "Астана, Айтматова 36",
  phone: "+77779487708",
  timezone: "Asia/Almaty",
  pendingHours: 4,
  horizonDays: 90,
  leadMinutes: 30,
  reminderHours: 24,
  privacyVersion: "draft-1",
  privacyApproved: false,
  privacyText:
    "Проект политики: укажите владельца салона, контакты для обращений, цели обработки, сроки хранения, используемых поставщиков и порядок удаления данных. Перед запуском согласуйте текст с владельцем и проверьте применимые требования к персональным данным.",
  durationsApproved: false,
  turnstileSiteKey: "",
  services,
  masters: [
    { id: "master-1", name: "Назигуль", services: all, active: true },
    {
      id: "master-2",
      name: "Арай",
      services: all.filter((id) => id !== "service-12"),
      active: true,
    },
    {
      id: "master-3",
      name: "Жазира",
      services: all.slice(8, 11),
      active: true,
    },
  ],
  weekly: Object.fromEntries(
    ["master-1", "master-2", "master-3"].map((id) => [
      id,
      Object.fromEntries(
        [0, 1, 2, 3, 4, 5, 6].map((day) => [day, [["10:00", "20:00"]]]),
      ),
    ]),
  ),
};
