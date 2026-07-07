import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createCookieStorage } from "./cookieStorage";

type MockUserState = {
  mockUserId: string | null;
  setMockUserId: (id: string | null) => void;
};

export const useMockUserStore = create<MockUserState>()(
  persist(
    (set) => ({
      mockUserId: null,
      setMockUserId: (id) => set({ mockUserId: id }),
    }),
    {
      name: "waypoint.mockUserId",
      storage: createJSONStorage(() => createCookieStorage()),
    },
  ),
);
