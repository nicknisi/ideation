import type { APIRoute, GetStaticPaths } from 'astro';
import { CONTRACT_STATES, walkthrough, type ContractState } from '../../../../lib/native';

// The walkthrough's contracts, exactly as the Pi extension renders them. They
// are served as their own documents (and framed by the walkthrough) because a
// contract is a self-contained page with its own theme toggle and print sheet.
export const getStaticPaths = (() => CONTRACT_STATES.map(state => ({ params: { state } }))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ params }) => {
  const { contracts } = await walkthrough();
  return new Response(contracts[params.state as ContractState], {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
};
