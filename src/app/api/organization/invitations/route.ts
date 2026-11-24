import { z } from "zod";
import { requireIdentity } from "@/server/auth";
import { authorize } from "@/server/auth/rbac";
import { emailSchema, roleSchema } from "@/server/auth/schemas";
import { checkOrigin, errorResponse, readJson } from "@/server/http";
import { inviteMember, teamOverview } from "@/server/team";

const schema = z.object({ email: emailSchema, role: roleSchema });

export async function GET() {
  try {
    return Response.json(await teamOverview(await requireIdentity()));
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const actor = await requireIdentity();
    authorize(actor, "organization:manage");
    const invitation = await inviteMember(
      actor,
      schema.parse(await readJson(request)),
    );
    return Response.json(invitation, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
