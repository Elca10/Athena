import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Dashboard } from "./Dashboard";

test("renders the top bar actions and both main columns", () => {
  render(<Dashboard />);

  expect(screen.getByRole("heading", { name: "Athena" })).toBeInTheDocument();
  for (const label of ["Report a bug", "Tune Athena", "Calendar", "Archive"]) {
    expect(screen.getByRole("button", { name: label })).toBeDisabled();
  }

  expect(screen.getByRole("heading", { name: "Subjects" })).toBeInTheDocument();
  expect(screen.getByText("No subjects yet.")).toBeInTheDocument();

  for (const label of ["Active", "Waiting", "Completed"]) {
    expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
  }
  expect(screen.getAllByText("Nothing here yet.")).toHaveLength(3);
});
