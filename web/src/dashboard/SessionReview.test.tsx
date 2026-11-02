import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { SessionReview } from "./SessionReview";
import type { Session } from "./api";

function session(history: unknown[]): Session {
  return { id: "done-1", subjectIds: ["s1"], mode: "ready", status: "completed", endedAt: "2026-01-03T00:00:00.000Z", archived: false, currentQuestion: null, history };
}

test("lists every answered question with the user's answer and the answer key (issue #14)", () => {
  render(
    <SessionReview
      subjectLabel="Biology"
      onClose={() => {}}
      session={session([
        { type: "multiple_choice", prompt: "Which organelle makes ATP?", choices: ["Nucleus", "Mitochondrion"], correctIndex: 1, selectedIndex: 0, rating: "again" },
        { type: "cloze", prompt: "DNA is copied by _____.", answerText: "ligase", clozeAnswer: "DNA polymerase", rating: "again" },
        {
          type: "short_answer",
          prompt: "What is osmosis?",
          answerText: "Water moving across a membrane",
          modelAnswer: "Water diffusing across a semipermeable membrane.",
          rubric: ["water moves", "semipermeable membrane"],
          selfGrades: [{ status: "got_it" }, { status: "partly" }],
          rating: "hard",
        },
        { type: "explain", prompt: "Why do cells divide?", answerText: "To grow", feedback: "Also repair and reproduction.", rating: "good" },
      ])}
    />,
  );

  const dialog = screen.getByRole("dialog", { name: "Biology: questions" });
  const items = within(dialog).getAllByRole("listitem").filter((li) => li.classList.contains("session-review-item"));
  expect(items).toHaveLength(4);

  expect(within(items[0]).getByText("Missed")).toBeInTheDocument();
  expect(within(items[0]).getByText("Nucleus").textContent).toContain("(your answer)");
  expect(within(items[0]).getByText("Mitochondrion").textContent).toContain("(correct)");

  expect(within(items[1]).getByText("ligase")).toBeInTheDocument();
  expect(within(items[1]).getByText("Correct answer")).toBeInTheDocument();
  expect(within(items[1]).getByText("DNA polymerase")).toBeInTheDocument();

  expect(within(items[2]).getByText("Shaky")).toBeInTheDocument();
  expect(within(items[2]).getByText("Water diffusing across a semipermeable membrane.")).toBeInTheDocument();
  expect(within(items[2]).getByText("semipermeable membrane: Partly")).toBeInTheDocument();

  expect(within(items[3]).getByText("Got it")).toBeInTheDocument();
  expect(within(items[3]).getByText("Also repair and reproduction.")).toBeInTheDocument();
});

test("a multiple-choice answer that was right is tagged both ways", () => {
  render(
    <SessionReview
      subjectLabel="Biology"
      onClose={() => {}}
      session={session([{ type: "multiple_choice", prompt: "Q?", choices: ["a", "b"], correctIndex: 0, selectedIndex: 0, rating: "good" }])}
    />,
  );
  expect(screen.getByText("a").textContent).toContain("(your answer, correct)");
});

test("Close and Escape both close it", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<SessionReview subjectLabel="Biology" onClose={onClose} session={session([{ type: "explain", prompt: "Q?", answerText: "A", rating: "good" }])} />);
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(2);
});
