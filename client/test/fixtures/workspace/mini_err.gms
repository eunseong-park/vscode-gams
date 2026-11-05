$title Mini Shipping Problem, error variant
Sets
   d 'depots' / north, south /
   s 'shops'  / east, west /;
$include mini_err_inc.inc
Parameter stock(d) / north 90, south 60 /;
Variables x;
Equation e;
e.. x =e= stock('north') + missing;
Model m / e /;
Solve m using lp minimizing x;
$include does_not_exist.inc
