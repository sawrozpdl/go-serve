# बिक्री तालिकाबाट मेटाउँदाको सन्देश — Delete refusal

*IRD office checklist item 11(झ): what happens when someone tries to delete or change data in the master sales table. Generate against production and paste the output below:*

```bash
DATABASE_URL=… scripts/ird/delete-refusal.sh <café-slug>
```

The script runs as the **application's database role**, against an issued invoice of the named café, and tries:
1. `DELETE` of the invoice;
2. `UPDATE` of its total;
3. `DELETE` of its lines;
4. `UPDATE` of the order behind it;
5. `DELETE` of its payment.

Each attempt is refused by the database:

```
{{paste output}}
```

In the application itself, issued bills have no edit or delete action at all. The only corrections are a reverse entry or a sales return (Order history → Return / cancel), and both create new numbered documents.
