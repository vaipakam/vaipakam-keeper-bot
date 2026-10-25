/**
 * The ABIs the bot calls the Diamond with, one per facet (#13).
 *
 * Each is that facet's generated `as const` ABI (src/abis/typed/, from the
 * exported JSON) with the Diamond-wide error set appended. Two properties
 * follow, and both are the point:
 *
 *  - **Calls are typed by the facet that defines the function.** viem infers
 *    `functionName`, `args` and the result from the ABI, so a renamed
 *    function, a changed argument list or a changed return shape fails
 *    `npm run typecheck` instead of failing at run time (#12: `previewMatch`
 *    gained two arguments and every match preview silently returned null). A
 *    call made against a facet that does not define the function fails too.
 *    That is how the internal matcher's `triggerInternalMatchLiquidation`,
 *    which moved to RiskMatchLiquidationFacet, was found to be unresolvable.
 *  - **Every revert decodes by name.** A facet's own ABI lists only some of
 *    the Diamond's errors, and a cross-facet call passes the callee's revert
 *    straight through, so the full set is appended to each.
 *
 * Diamond selectors are unique by construction, so pairing any facet's
 * functions with the shared error set is always unambiguous.
 */
import AdminFacet from './typed/AdminFacet.ts';
import AutoLifecycleFacet from './typed/AutoLifecycleFacet.ts';
import ConfigFacet from './typed/ConfigFacet.ts';
import ForcedSaleFacet from './typed/ForcedSaleFacet.ts';
import LoanFacet from './typed/LoanFacet.ts';
import MetricsFacet from './typed/MetricsFacet.ts';
import OfferCancelFacet from './typed/OfferCancelFacet.ts';
import OfferMatchFacet from './typed/OfferMatchFacet.ts';
import RiskFacet from './typed/RiskFacet.ts';
import RiskMatchLiquidationFacet from './typed/RiskMatchLiquidationFacet.ts';
import DIAMOND_ERRORS from './typed/DiamondErrors.ts';

export const ADMIN_ABI = [...AdminFacet, ...DIAMOND_ERRORS] as const;
export const AUTO_LIFECYCLE_ABI = [...AutoLifecycleFacet, ...DIAMOND_ERRORS] as const;
export const CONFIG_ABI = [...ConfigFacet, ...DIAMOND_ERRORS] as const;
export const FORCED_SALE_ABI = [...ForcedSaleFacet, ...DIAMOND_ERRORS] as const;
export const LOAN_ABI = [...LoanFacet, ...DIAMOND_ERRORS] as const;
export const METRICS_ABI = [...MetricsFacet, ...DIAMOND_ERRORS] as const;
export const OFFER_CANCEL_ABI = [...OfferCancelFacet, ...DIAMOND_ERRORS] as const;
export const OFFER_MATCH_ABI = [...OfferMatchFacet, ...DIAMOND_ERRORS] as const;
export const RISK_ABI = [...RiskFacet, ...DIAMOND_ERRORS] as const;
export const RISK_MATCH_LIQUIDATION_ABI = [...RiskMatchLiquidationFacet, ...DIAMOND_ERRORS] as const;
