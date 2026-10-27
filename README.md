# GymBuddy

**A personal workout tracker for the gym.**

**[Open GymBuddy](https://shadmansakibrahman.github.io/GymBuddy/)**

---

I built this to track my own gym sessions — log what I lift, see what I did last time, and follow a structured progression plan. It works on your phone at the gym and syncs across devices.

**What it does:**

- Track workouts across a customizable training cycle
- Log weight and reps for each exercise, check them off as you go
- See your last session's numbers before every workout
- Edit your workout plan — add, remove, or change any exercise
- View session history and progression over time
- Sign in with Google or email — data syncs to the cloud

I made it for myself, but the plan is fully customizable so anyone can use it for their own routine.

---

**Development**

Everything lives in `index.html`. Tests need only Node (no dependencies):

```
node tests/test_session.js   # session logic: nothing is logged until LOG SESSION, refresh keeps typed numbers
node tests/test_more.js      # migration, multi-device merge, per-account storage, plan edits, import
node tests/e2e.js            # drives the real app in headless Chrome/Edge (needs internet for the Firebase SDK)
```

