import { Link } from "@tanstack/react-router";
import { MessageShell } from "@/components/status/error-page";

/**
 * A URL that is not on the board. The tab title says so too, from the root
 * route's head (a second <title> here would sit beside the first, and the
 * browser reads only the first); the server answers 404 whatever this renders.
 */
export function NotFoundPage() {
  return (
    <MessageShell title="Nothing here.">
      <p>
        <Link to="/" className="focus-ring rounded-sm text-accent underline underline-offset-4">
          Back to the board.
        </Link>
      </p>
    </MessageShell>
  );
}
